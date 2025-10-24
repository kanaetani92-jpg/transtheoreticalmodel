import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { addDoc, collection, doc, getDocs, onSnapshot, orderBy, query, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../lib/firebase";

type Msg = { id?: string; role: "user" | "assistant"; text: string; createdAt?: any; };
type Session = {
  id: string;
  title: string;
  createdAt?: any;
  stageHeadline?: string;
  stageDescription?: string;
};

type StageOutcome = { headline: string; description: string; prompt: string };

type StageBranch =
  | { type: "step"; next: number }
  | { type: "result"; outcome: StageOutcome };

type StageNode = {
  question: string;
  yesLabel: string;
  noLabel: string;
  yes: StageBranch;
  no: StageBranch;
};

const stageNodes: StageNode[] = [
  {
    question: "変えたい行動について、すでに6か月以上継続して取り組めていますか？",
    yesLabel: "はい、6か月以上続けられている",
    noLabel: "いいえ、まだ6か月は経っていない",
    yes: {
      type: "result",
      outcome: {
        headline: "新しい行動を6か月以上維持できています",
        description:
          "身につけた行動を安定して続けられている段階です。これまで効果的だった工夫を振り返り、続けるための環境づくりに意識を向けましょう。",
        prompt: "この状態を支えるためのサポート内容を一緒に考えていきます。",
      },
    },
    no: { type: "step", next: 1 },
  },
  {
    question: "その行動には過去6か月以内に着手しましたか？",
    yesLabel: "はい、始めてから6か月未満です",
    noLabel: "いいえ、まだ始めていません",
    yes: {
      type: "result",
      outcome: {
        headline: "行動を始めてから6か月未満の状態です",
        description:
          "すでに行動を起こしており、軌道に乗せることに集中する段階です。成功体験を増やし、続けるための障害を一緒に整理していきましょう。",
        prompt: "継続を安定させる視点で対話を進めます。",
      },
    },
    no: { type: "step", next: 2 },
  },
  {
    question: "今後30日以内に具体的な行動を始める計画がありますか？",
    yesLabel: "はい、30日以内に始めるつもりです",
    noLabel: "いいえ、30日以内には予定していません",
    yes: {
      type: "result",
      outcome: {
        headline: "近いうちに行動を始める強い意図があります",
        description:
          "具体的な計画を立て、実行に移す直前の段階です。開始日や方法、想定される障害への対処を一緒に整理していきましょう。",
        prompt: "計画の具体化と準備を支援する質問から始めます。",
      },
    },
    no: { type: "step", next: 3 },
  },
  {
    question: "今後6か月以内には行動を始めたいと考えていますか？",
    yesLabel: "はい、6か月以内には始めたいと思っています",
    noLabel: "いいえ、まだ始める気持ちは固まっていません",
    yes: {
      type: "result",
      outcome: {
        headline: "行動を始めたい気持ちが芽生えています",
        description:
          "利点と不安を天秤にかけながら検討している段階です。動機づけや情報整理を通じて、前向きな気持ちを育てるサポートが有効です。",
        prompt: "気持ちの整理と一歩踏み出すための対話を進めましょう。",
      },
    },
    no: {
      type: "result",
      outcome: {
        headline: "まだ行動を始める予定は定まっていません",
        description:
          "今は変化の必要性を感じにくい、または関心が薄い段階です。気づきや情報提供を通じて、行動の意味づけを一緒に考えていきましょう。",
        prompt: "関心を高めるためのテーマから対話を始めます。",
      },
    },
  },
];

const needsStageInfo = (session?: Session) => {
  if (!session) return true;
  return !session.stageHeadline || !session.stageDescription;
};

export default function Home() {
  const [user, setUser] = useState<any>(null);
  const [email, setEmail] = useState(""); 
  const [password, setPassword] = useState("");
  const [isSignup, setIsSignup] = useState(false);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stageFlowOpen, setStageFlowOpen] = useState(false);
  const [stageNodeIndex, setStageNodeIndex] = useState(0);
  const [stageResult, setStageResult] = useState<StageOutcome | null>(null);
  const [stageFlowSessionId, setStageFlowSessionId] = useState<string | null>(null);

  const startStageFlow = (sessionId: string) => {
    setStageFlowSessionId(sessionId);
    setStageNodeIndex(0);
    setStageResult(null);
    setStageFlowOpen(true);
  };

  const maxLen = 5000;
  const rest = maxLen - input.length;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (!u) {
        setSessions([]);
        setMessages([]);
        setCurrentSessionId(null);
        setStageFlowOpen(false);
        setStageFlowSessionId(null);
        setStageResult(null);
        setStageNodeIndex(0);
        return;
      }
      const coll = collection(db, "users", u.uid, "sessions");
      const qs = await getDocs(query(coll, orderBy("createdAt", "desc")));
      const ss: Session[] = qs.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      setSessions(ss);
      if (ss.length > 0) {
        const firstSession = ss[0];
        setCurrentSessionId(firstSession.id);
        if (needsStageInfo(firstSession)) {
          startStageFlow(firstSession.id);
        } else {
          setStageFlowOpen(false);
          setStageFlowSessionId(null);
          setStageResult(null);
          setStageNodeIndex(0);
        }
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user || !currentSessionId) {
      setMessages([]);
      return;
    }
    const coll = collection(db, "users", user.uid, "sessions", currentSessionId, "messages");
    const q = query(coll, orderBy("createdAt", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      const arr: Msg[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      setMessages(arr);
    });
    return () => unsub();
  }, [user, currentSessionId]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSignup) {
      await createUserWithEmailAndPassword(auth, email, password);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  const resetStageFlow = () => {
    if (!stageFlowSessionId) return;
    setStageNodeIndex(0);
    setStageResult(null);
  };

  const createNewSession = async () => {
    if (!user) return;
    const title = `セッション ${new Date().toLocaleString()}`;
    const coll = collection(db, "users", user.uid, "sessions");
    const ref = await addDoc(coll, { title, createdAt: serverTimestamp() });
    const optimisticSession: Session = {
      id: ref.id,
      title,
      createdAt: new Date(),
    };
    setSessions((prev) => [optimisticSession, ...prev]);
    setCurrentSessionId(ref.id);
    startStageFlow(ref.id);
  };

  const selectSession = (id: string) => {
    setCurrentSessionId(id);
    const target = sessions.find((s) => s.id === id);
    if (needsStageInfo(target)) {
      startStageFlow(id);
    } else {
      setStageFlowOpen(false);
      setStageFlowSessionId(null);
      setStageResult(null);
      setStageNodeIndex(0);
    }
  };

  const handleStageAnswer = (answer: "yes" | "no") => {
    if (stageResult) return;
    const node = stageNodes[stageNodeIndex];
    if (!node) return;
    const branch = answer === "yes" ? node.yes : node.no;
    if (branch.type === "step") {
      setStageNodeIndex(branch.next);
      return;
    }
    setStageResult(branch.outcome);
  };

  const completeStageFlow = async () => {
    if (!user || !stageFlowSessionId || !stageResult) return;
    const ref = doc(db, "users", user.uid, "sessions", stageFlowSessionId);
    const combinedDescription = `${stageResult.description}\n${stageResult.prompt}`;
    await setDoc(
      ref,
      {
        stageHeadline: stageResult.headline,
        stageDescription: combinedDescription,
      },
      { merge: true }
    );
    setSessions((prev) =>
      prev.map((s) =>
        s.id === stageFlowSessionId
          ? {
              ...s,
              stageHeadline: stageResult.headline,
              stageDescription: combinedDescription,
            }
          : s
      )
    );
    setStageFlowOpen(false);
    setStageFlowSessionId(null);
    setStageResult(null);
    setStageNodeIndex(0);
  };

  const sendMessage = async () => {
    if (!user || !currentSessionId) return;
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > maxLen) return;

    setSendError(null);
    setSending(true);
    const coll = collection(db, "users", user.uid, "sessions", currentSessionId, "messages");
    let userMessageSaved = false;

    try {
      await addDoc(coll, { role: "user", text: trimmed, createdAt: serverTimestamp() });
      userMessageSaved = true;

      // 直近の履歴（負荷軽減のため最大10件）を送る
      const recent = messages.slice(-9).concat([{ role: "user", text: trimmed }]);
      const sessionMeta = sessions.find((s) => s.id === currentSessionId);
      const stagePayload =
        sessionMeta && sessionMeta.stageHeadline && sessionMeta.stageDescription
          ? {
              headline: sessionMeta.stageHeadline,
              description: sessionMeta.stageDescription,
            }
          : undefined;
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: recent,
          sessionId: currentSessionId,
          userId: user.uid,
          stage: stagePayload,
        })
      });
      if (!res.ok) {
        throw new Error(`request_failed:${res.status}`);
      }
      const data = await res.json();
      const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
      if (!reply) {
        throw new Error("empty_reply");
      }
      setInput("");
      // フォーカス復帰
      textareaRef.current?.focus();
    } catch (e) {
      console.error(e);
      if (userMessageSaved) {
        try {
          await addDoc(coll, {
            role: "assistant",
            text:
              "申し訳ありません。Geminiからの応答を取得できませんでした。時間をおいて再度お試しください。",
            createdAt: serverTimestamp()
          });
        } catch (err) {
          console.error("failed_to_write_error_message", err);
        }
      }
      setSendError("メッセージを送信できませんでした。通信状況をご確認のうえ、時間をおいて再度お試しください。");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter: 改行（デフォルト）、Shift+Enter: 送信
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      if (!sending) sendMessage();
    }
  };

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const latestSessions = sessions.slice(0, 3);
  const olderSessions = sessions.slice(3);
  const olderSelected =
    olderSessions.find((s) => s.id === currentSessionId)?.id ?? "";

  const chatPane = (
    <div className="chat-pane">
      <div className="chat-header">
        <div>
          <button onClick={createNewSession} className="btn">新規セッション</button>
        </div>
        <div className="session-list">
          {latestSessions.length > 0 && (
            <div className="session-cards">
              {latestSessions.map((s) => (
                <button
                  key={s.id}
                  className={`session-card ${currentSessionId === s.id ? "active" : ""}`}
                  onClick={() => selectSession(s.id)}
                  title={s.title}
                >
                  <span className="session-card-title">{s.title}</span>
                </button>
              ))}
            </div>
          )}
          {olderSessions.length > 0 && (
            <select
              className="session-dropdown"
              value={olderSelected}
              onChange={(e) => {
                if (e.target.value) {
                  selectSession(e.target.value);
                }
              }}
            >
              <option value="">以前のセッションを選択</option>
              {olderSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <button onClick={handleLogout} className="btn-secondary">ログアウト</button>
        </div>
      </div>

      {currentSession?.stageHeadline && currentSession?.stageDescription && (
        <div className="stage-summary">
          <h2>{currentSession.stageHeadline}</h2>
          <p>{currentSession.stageDescription}</p>
        </div>
      )}

      <div className="messages">
        {messages.map((m, index) => {
          const messageKey = m.id
            ?? (m.createdAt?.seconds != null
              ? `message-${m.createdAt.seconds}-${m.createdAt.nanoseconds ?? 0}-${m.role}`
              : `message-${index}`);
          return (
            <div key={messageKey} className={`msg ${m.role}`}>
              <div className="bubble">
                {m.text}
              </div>
            </div>
          );
        })}
      </div>

      <div className="composer">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            if (sendError) setSendError(null);
            setInput(e.target.value);
          }}
          onKeyDown={onKeyDown}
          maxLength={maxLen}
          placeholder="ここに記入（最大5000字）。Enterで改行、Shift+Enterで送信。"
        />
        {sendError && <p className="composer-error" role="status">{sendError}</p>}
        <div className="composer-footer">
          <span className={rest < 0 ? "counter over" : "counter"}>残り {rest} 字</span>
          <button className="btn" onClick={sendMessage} disabled={sending || !input.trim()}>送信（Shift+Enter）</button>
        </div>
      </div>
    </div>
  );

  if (!user)
    return (
      <main className="auth">
        <h1>TTMベース対話型ストレスマネジメント</h1>
        <form onSubmit={handleAuth} className="auth-form">
          <input type="email" placeholder="メールアドレス" value={email} onChange={(e)=>setEmail(e.target.value)} required />
          <input type="password" placeholder="パスワード" value={password} onChange={(e)=>setPassword(e.target.value)} required />
          <button className="btn" type="submit">{isSignup ? "サインアップ" : "ログイン"}</button>
          <button type="button" className="link" onClick={()=>setIsSignup(!isSignup)}>
            {isSignup ? "ログインへ" : "新規登録へ"}
          </button>
        </form>
      </main>
    );

  const currentStageNode = stageNodes[stageNodeIndex];
  const shouldShowStageFlow =
    stageFlowOpen && stageFlowSessionId && stageFlowSessionId === currentSessionId;

  return (
    <main className="container">
      {sessions.length > 0 ? chatPane : (
        <div className="empty">
          <p>セッションがありません。まずは作成してください。</p>
          <button className="btn" onClick={createNewSession}>新規セッション</button>
          <button className="btn-secondary" onClick={handleLogout}>ログアウト</button>
        </div>
      )}

      {shouldShowStageFlow && (
        <div className="stage-overlay">
          <div className="stage-card">
            {stageResult ? (
              <>
                <h2>現在の取り組み状況</h2>
                <p className="stage-headline">{stageResult.headline}</p>
                <p>{stageResult.description}</p>
                <p className="stage-prompt">{stageResult.prompt}</p>
                <div className="stage-actions">
                  <button className="btn" onClick={completeStageFlow}>この内容でチャットを始める</button>
                  <button className="btn-secondary" onClick={resetStageFlow}>回答をやり直す</button>
                </div>
              </>
            ) : currentStageNode ? (
              <>
                <h2>まず現在の状況を教えてください</h2>
                <p className="stage-question">{currentStageNode.question}</p>
                <div className="stage-options">
                  <button className="stage-option primary" onClick={() => handleStageAnswer("yes")}>
                    {currentStageNode.yesLabel}
                  </button>
                  <button className="stage-option" onClick={() => handleStageAnswer("no")}>
                    {currentStageNode.noLabel}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
    </main>
  );
}
