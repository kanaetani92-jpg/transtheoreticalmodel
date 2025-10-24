import { createSign, randomUUID } from "crypto";

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

let cachedAccount: ServiceAccount | null = null;
let cachedToken: CachedToken | null = null;

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeServiceAccount(raw: string): ServiceAccount {
  let json = raw.trim();
  try {
    return JSON.parse(json);
  } catch (err) {
    try {
      const decoded = Buffer.from(json, "base64").toString("utf8");
      return JSON.parse(decoded);
    } catch (innerErr) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY must be valid JSON or base64-encoded JSON");
    }
  }
}

function getServiceAccount(): ServiceAccount {
  if (cachedAccount) return cachedAccount;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw || !raw.trim()) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY is not set");
  }
  const account = decodeServiceAccount(raw);
  if (!account.project_id || !account.client_email || !account.private_key) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY is missing required fields");
  }
  cachedAccount = account;
  return account;
}

async function getAccessToken(): Promise<string> {
  const account = getServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) {
    return cachedToken.accessToken;
  }

  const header = {
    alg: "RS256",
    typ: "JWT"
  };

  const payload = {
    iss: account.client_email,
    sub: account.client_email,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: "https://www.googleapis.com/auth/datastore"
  };

  const unsignedToken = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(account.private_key);
  const jwt = `${unsignedToken}.${base64UrlEncode(signature)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`failed_to_exchange_token:${res.status}:${text}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token || !data.expires_in) {
    throw new Error("invalid_token_response");
  }

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in
  };
  return data.access_token;
}

function buildDocumentName(params: { projectId: string; userId: string; sessionId: string; messageId: string }): string {
  const { projectId, userId, sessionId, messageId } = params;
  return `projects/${projectId}/databases/(default)/documents/users/${userId}/sessions/${sessionId}/messages/${messageId}`;
}

export async function saveAssistantMessage(params: { userId: string; sessionId: string; text: string }): Promise<void> {
  const { userId, sessionId, text } = params;
  if (!userId || !sessionId) {
    throw new Error("missing_firestore_path_params");
  }
  const account = getServiceAccount();
  const accessToken = await getAccessToken();
  const messageId = randomUUID();
  const trimmedText = text.length > 10000 ? text.slice(0, 10000) : text;
  const documentName = buildDocumentName({
    projectId: account.project_id,
    userId,
    sessionId,
    messageId
  });

  const commitUrl = `https://firestore.googleapis.com/v1/projects/${account.project_id}/databases/(default)/documents:commit`;

  const body = {
    writes: [
      {
        update: {
          name: documentName,
          fields: {
            role: { stringValue: "assistant" },
            text: { stringValue: trimmedText }
          }
        },
        currentDocument: { exists: false }
      },
      {
        transform: {
          document: documentName,
          fieldTransforms: [
            {
              fieldPath: "createdAt",
              setToServerValue: "REQUEST_TIME"
            }
          ]
        }
      }
    ]
  };

  const res = await fetch(commitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`failed_to_write_firestore:${res.status}:${text}`);
  }
}

