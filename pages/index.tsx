import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { addDoc, collection, doc, getDocs, onSnapshot, orderBy, query, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../lib/firebase";

type Msg = { id?: string; role: "user" | "assistant"; text: string; createdAt?: any; };
type Session = { id: string; title: string; createdAt?: any; };

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
        return;
      }
      const coll = collection(db, "users", u.uid, "sessions");
      const qs = await getDocs(query(coll, orderBy("createdAt", "desc")));
      const ss: Session[] = qs.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      setSessions(ss);
      if (ss.length > 0) {
        setCurrentSessionId(ss[0].id);
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

  const createNewSession = async () => {
    if (!user) return;
    const title = `セッション ${new Date().toLocaleString()}`;
    const coll = collection(db, "users", user.uid, "sessions");
    const ref = await addDoc(coll, { title, createdAt: serverTimestamp() });
    setCurrentSessionId(ref.id);
  };

  const selectSession = (id: string) => setCurrentSessionId(id);

  const sendMessage = async () => {
    if (!user || !currentSessionId) return;
    if (!input.trim() || input.length > maxLen) return;
    setSending(true);
    const coll = collection(db, "users", user.uid, "sessions", currentSessionId, "messages");
    await addDoc(coll, { role: "user", text: input.trim(), createdAt: serverTimestamp() });

    try {
      // 直近の履歴（負荷軽減のため最大10件）を送る
      const recent = messages.slice(-9).concat([{ role: "user", text: input.trim() }]);
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: recent })
      });
      const data = await res.json();
      const reply = data?.reply ?? "";
      await addDoc(coll, { role: "assistant", text: reply, createdAt: serverTimestamp() });
      setInput("");
      // フォーカス復帰
      textareaRef.current?.focus();
    } catch (e) {
      console.error(e);
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

  const chatPane = useMemo(() => (
    <div className="chat-pane">
      <div className="chat-header">
        <div>
          <button onClick={createNewSession} className="btn">新規セッション</button>
        </div>
        <div className="session-list">
          {sessions.length > 0 && (
            <div className="session-scroll">
              {sessions.map(s => (
                <button
                  key={s.id}
                  className={`session-btn ${currentSessionId === s.id ? "active" : ""}`}
                  onClick={() => selectSession(s.id)}
                  title={s.title}
                >
                  {s.title}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <button onClick={handleLogout} className="btn-secondary">ログアウト</button>
        </div>
      </div>

      <div className="messages">
        {messages.map((m) => (
          <div key={m.id ?? Math.random()} className={`msg ${m.role}`}>
            <div className="bubble">
              {m.text}
            </div>
          </div>
        ))}
      </div>

      <div className="composer">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={maxLen}
          placeholder="ここに記入（最大5000字）。Enterで改行、Shift+Enterで送信。"
        />
        <div className="composer-footer">
          <span className={rest < 0 ? "counter over" : "counter"}>残り {rest} 字</span>
          <button className="btn" onClick={sendMessage} disabled={sending || !input.trim()}>送信（Shift+Enter）</button>
        </div>
      </div>
    </div>
  ), [sessions, currentSessionId, messages, input, sending, rest]);

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

  return (
    <main className="container">
      {sessions.length > 0 ? chatPane : (
        <div className="empty">
          <p>セッションがありません。まずは作成してください。</p>
          <button className="btn" onClick={createNewSession}>新規セッション</button>
          <button className="btn-secondary" onClick={handleLogout}>ログアウト</button>
        </div>
      )}
    </main>
  );
}
