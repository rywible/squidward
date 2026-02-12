import { Database } from "@squidward/db";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

interface IntegrationsOptions {
  dbPath: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  runCommand?: CommandRunner;
}

type SqlRecord = Record<string, unknown>;

type OAuthProvider = "slack" | "linear";

type CommandRunner = (
  command: string,
  args: string[]
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  redirectUri: string;
}

interface OAuthStartResponse {
  ok: true;
  provider: OAuthProvider;
  authorizeUrl: string;
  state: string;
  expiresAt: string;
}

interface OAuthCallbackResponse {
  ok: boolean;
  provider: OAuthProvider;
  status: "connected" | "failed";
  accountRef?: string;
  expiresAt?: string | null;
  error?: string;
}

interface ProviderStatus {
  provider: string;
  configured: boolean;
  connected: boolean;
  status: string;
  checkedAt: string;
  detail?: string;
  expiresAt?: string | null;
  refreshSupported?: boolean;
}

interface ConnectionRow {
  id: string;
  account_ref: string;
  status: string;
  scopes: string;
  expires_at: string | null;
  updated_at: string;
}

const sanitizeCommandDetail = (raw: string): string => {
  return raw
    .split("\n")
    .filter((line) => !/token/i.test(line))
    .join("\n")
    .trim();
};

const nowIso = (): string => new Date().toISOString();

const toBase64Url = (value: Buffer): string => value.toString("base64url");

const makePkcePair = (): { verifier: string; challenge: string } => {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

const parseScopes = (value: string): string[] => {
  return value
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
};

const addSeconds = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString();

const resolveProvider = (provider: string): OAuthProvider | null => {
  if (provider === "slack" || provider === "linear") {
    return provider;
  }
  return null;
};

const defaultRunCommand: CommandRunner = async (command, args) => {
  try {
    const result = Bun.spawnSync([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      exitCode: result.exitCode ?? 1,
      stdout: Buffer.from(result.stdout).toString("utf8").trim(),
      stderr: Buffer.from(result.stderr).toString("utf8").trim(),
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : "command_failed",
    };
  }
};

class SecretCipher {
  private readonly key: Buffer;

  constructor(seed: string) {
    this.key = createHash("sha256").update(seed).digest();
  }

  encrypt(data: Record<string, unknown>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(data), "utf8");
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decrypt(cipherBlob: string): Record<string, unknown> | null {
    const [version, payload] = cipherBlob.split(":", 2);
    if (version !== "v1" || !payload) {
      return null;
    }

    const [ivRaw, tagRaw, encryptedRaw] = payload.split(".");
    if (!ivRaw || !tagRaw || !encryptedRaw) {
      return null;
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivRaw, "base64url"));
      decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedRaw, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      const parsed = JSON.parse(decrypted) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
}

export class IntegrationsService {
  private readonly db: Database;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: FetchLike;
  private readonly runCommand: CommandRunner;
  private readonly cipher: SecretCipher;

  constructor(options: IntegrationsOptions) {
    this.db = new Database(options.dbPath, { create: true, strict: false });
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runCommand = options.runCommand ?? defaultRunCommand;

    const encryptionSeed =
      this.env.OAUTH_SECRET_KEY ?? this.env.AGENT_ENCRYPTION_KEY ?? this.env.AGENT_SECRET_KEY ?? "dev-oauth-key";
    this.cipher = new SecretCipher(encryptionSeed);

    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        account_ref TEXT NOT NULL,
        auth_type TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        expires_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS secret_records (
        id TEXT PRIMARY KEY,
        secret_name TEXT NOT NULL,
        provider TEXT NOT NULL,
        cipher_blob TEXT NOT NULL,
        version INTEGER NOT NULL,
        rotated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_validated_at TEXT
      );
    `);
  }

  private providerConfig(provider: OAuthProvider): ProviderConfig | null {
    const baseUrl =
      this.env.OAUTH_BASE_URL ??
      this.env.OAUTH_REDIRECT_BASE ??
      this.env.API_BASE_URL ??
      this.env.PUBLIC_API_BASE_URL ??
      "";

    if (provider === "slack") {
      const clientId = this.env.SLACK_CLIENT_ID ?? "";
      const clientSecret = this.env.SLACK_CLIENT_SECRET ?? "";
      const redirectUri =
        this.env.SLACK_OAUTH_REDIRECT_URI ??
        (baseUrl ? `${baseUrl.replace(/\/$/, "")}/oauth/slack/callback` : "");
      const scopes = parseScopes(this.env.SLACK_OAUTH_SCOPES ?? "commands chat:write");

      if (!clientId || !clientSecret || !redirectUri) {
        return null;
      }

      return { clientId, clientSecret, scopes, redirectUri };
    }

    const clientId = this.env.LINEAR_CLIENT_ID ?? "";
    const clientSecret = this.env.LINEAR_CLIENT_SECRET ?? "";
    const redirectUri =
      this.env.LINEAR_OAUTH_REDIRECT_URI ??
      (baseUrl ? `${baseUrl.replace(/\/$/, "")}/oauth/linear/callback` : "");
    const scopes = parseScopes(this.env.LINEAR_OAUTH_SCOPES ?? "read");

    if (!clientId || !clientSecret || !redirectUri) {
      return null;
    }

    return { clientId, clientSecret, scopes, redirectUri };
  }

  private insertSecretRecord(provider: string, secretName: string, payload: Record<string, unknown>): void {
    const id = `sec_${randomBytes(10).toString("hex")}`;
    const cipherBlob = this.cipher.encrypt(payload);
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO secret_records (id, secret_name, provider, cipher_blob, version, rotated_at, last_validated_at)
         VALUES (?, ?, ?, ?, 1, ?, NULL)`
      )
      .run(id, secretName, provider, cipherBlob, now);
  }

  private latestSecret(provider: string, secretName: string): { id: string; cipher_blob: string } | null {
    const row = this.db
      .query(
        `SELECT id, cipher_blob
         FROM secret_records
         WHERE provider = ? AND secret_name = ?
         ORDER BY rotated_at DESC
         LIMIT 1`
      )
      .get(provider, secretName) as SqlRecord | null;

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      cipher_blob: String(row.cipher_blob),
    };
  }

  private latestConnection(provider: OAuthProvider): ConnectionRow | null {
    const row = this.db
      .query(
        `SELECT id, account_ref, status, scopes, expires_at, updated_at
         FROM auth_connections
         WHERE provider = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(provider) as SqlRecord | null;

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      account_ref: String(row.account_ref),
      status: String(row.status),
      scopes: String(row.scopes),
      expires_at: row.expires_at ? String(row.expires_at) : null,
      updated_at: String(row.updated_at),
    };
  }

  private async exchangeCode(
    provider: OAuthProvider,
    config: ProviderConfig,
    code: string,
    codeVerifier: string
  ): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
    if (provider === "slack") {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        code_verifier: codeVerifier,
      });

      const response = await this.fetchImpl("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });

      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok || data.ok !== true) {
        return { ok: false, error: String(data.error ?? `http_${response.status}`) };
      }

      return { ok: true, data };
    }

    const response = await this.fetchImpl("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: codeVerifier,
      }),
    });

    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok || typeof data.access_token !== "string") {
      return { ok: false, error: String(data.error ?? `http_${response.status}`) };
    }

    return { ok: true, data };
  }

  private async refreshToken(
    provider: OAuthProvider,
    config: ProviderConfig,
    refreshToken: string
  ): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
    if (provider === "slack") {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });

      const response = await this.fetchImpl("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });

      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok || data.ok !== true) {
        return { ok: false, error: String(data.error ?? `http_${response.status}`) };
      }

      return { ok: true, data };
    }

    const response = await this.fetchImpl("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok || typeof data.access_token !== "string") {
      return { ok: false, error: String(data.error ?? `http_${response.status}`) };
    }

    return { ok: true, data };
  }

  private applySuccessfulAuth(
    provider: OAuthProvider,
    connectionId: string,
    currentAccountRef: string,
    tokenPayload: Record<string, unknown>
  ): { accountRef: string; expiresAt: string | null } {
    const now = nowIso();

    let accountRef = currentAccountRef;
    let scopes: string[] = [];
    let accessToken = "";
    let refreshToken = "";
    let expiresAt: string | null = null;

    if (provider === "slack") {
      const team = (tokenPayload.team as Record<string, unknown> | undefined) ?? {};
      const authedUser = (tokenPayload.authed_user as Record<string, unknown> | undefined) ?? {};

      accountRef =
        (typeof team.id === "string" && team.id) ||
        (typeof authedUser.id === "string" && authedUser.id) ||
        currentAccountRef;

      const scopeValue = tokenPayload.scope;
      if (typeof scopeValue === "string") {
        scopes = parseScopes(scopeValue);
      }

      if (typeof tokenPayload.access_token === "string") {
        accessToken = tokenPayload.access_token;
      } else if (typeof authedUser.access_token === "string") {
        accessToken = authedUser.access_token;
      }

      if (typeof tokenPayload.refresh_token === "string") {
        refreshToken = tokenPayload.refresh_token;
      }

      if (typeof tokenPayload.expires_in === "number") {
        expiresAt = addSeconds(tokenPayload.expires_in);
      }
    } else {
      accountRef =
        (typeof tokenPayload.organization_id === "string" && tokenPayload.organization_id) ||
        (typeof tokenPayload.team_id === "string" && tokenPayload.team_id) ||
        currentAccountRef;

      if (typeof tokenPayload.scope === "string") {
        scopes = parseScopes(tokenPayload.scope);
      }

      if (typeof tokenPayload.access_token === "string") {
        accessToken = tokenPayload.access_token;
      }

      if (typeof tokenPayload.refresh_token === "string") {
        refreshToken = tokenPayload.refresh_token;
      }

      if (typeof tokenPayload.expires_in === "number") {
        expiresAt = addSeconds(tokenPayload.expires_in);
      }
    }

    this.db
      .query(
        `UPDATE auth_connections
         SET account_ref = ?, status = 'connected', scopes = ?, expires_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(accountRef, JSON.stringify(scopes), expiresAt, now, connectionId);

    if (accessToken) {
      this.insertSecretRecord(provider, `${provider}:access_token:${connectionId}`, {
        token: accessToken,
        savedAt: now,
      });
    }

    if (refreshToken) {
      this.insertSecretRecord(provider, `${provider}:refresh_token:${connectionId}`, {
        token: refreshToken,
        savedAt: now,
      });
    }

    return { accountRef, expiresAt };
  }

  async startOAuth(provider: string): Promise<Response> {
    const targetProvider = resolveProvider(provider);
    if (!targetProvider) {
      return Response.json({ ok: false, error: "unsupported_provider" }, { status: 404 });
    }

    const config = this.providerConfig(targetProvider);
    if (!config) {
      return Response.json(
        {
          ok: false,
          provider: targetProvider,
          error: "provider_not_configured",
        },
        { status: 400 }
      );
    }

    const state = randomBytes(16).toString("hex");
    const { verifier, challenge } = makePkcePair();
    const connectionId = `conn_${randomBytes(10).toString("hex")}`;
    const now = nowIso();
    const expiresAt = addSeconds(10 * 60);

    this.db
      .query(
        `INSERT INTO auth_connections (id, provider, account_ref, auth_type, scopes, status, expires_at, updated_at)
         VALUES (?, ?, ?, 'oauth2_pkce', ?, 'pending', ?, ?)`
      )
      .run(connectionId, targetProvider, state, JSON.stringify(config.scopes), expiresAt, now);

    this.insertSecretRecord(targetProvider, `oauth_state:${targetProvider}:${state}`, {
      connectionId,
      codeVerifier: verifier,
      redirectUri: config.redirectUri,
      createdAt: now,
    });

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    if (targetProvider === "slack") {
      params.set("scope", config.scopes.join(" "));
    } else {
      params.set("response_type", "code");
      params.set("scope", config.scopes.join(" "));
    }

    const authorizeUrl =
      targetProvider === "slack"
        ? `https://slack.com/oauth/v2/authorize?${params.toString()}`
        : `https://linear.app/oauth/authorize?${params.toString()}`;

    const response: OAuthStartResponse = {
      ok: true,
      provider: targetProvider,
      authorizeUrl,
      state,
      expiresAt,
    };

    return Response.json(response, {
      headers: {
        "cache-control": "no-store",
      },
    });
  }

  async completeOAuth(provider: string, url: URL): Promise<Response> {
    const targetProvider = resolveProvider(provider);
    if (!targetProvider) {
      return Response.json({ ok: false, error: "unsupported_provider" }, { status: 404 });
    }

    const config = this.providerConfig(targetProvider);
    if (!config) {
      return Response.json({ ok: false, provider: targetProvider, error: "provider_not_configured" }, { status: 400 });
    }

    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";

    if (!state) {
      return Response.json({ ok: false, provider: targetProvider, status: "failed", error: "missing_state" }, { status: 400 });
    }

    const pendingConnection = this.db
      .query(
        `SELECT id, account_ref, status
         FROM auth_connections
         WHERE provider = ? AND account_ref = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(targetProvider, state) as SqlRecord | null;

    if (!pendingConnection) {
      return Response.json({ ok: false, provider: targetProvider, status: "failed", error: "invalid_state" }, { status: 400 });
    }

    const connectionId = String(pendingConnection.id);

    if (error) {
      this.db
        .query(`UPDATE auth_connections SET status = 'failed', updated_at = ? WHERE id = ?`)
        .run(nowIso(), connectionId);

      return Response.json(
        {
          ok: false,
          provider: targetProvider,
          status: "failed",
          error,
        } satisfies OAuthCallbackResponse,
        { status: 400 }
      );
    }

    if (!code) {
      this.db
        .query(`UPDATE auth_connections SET status = 'failed', updated_at = ? WHERE id = ?`)
        .run(nowIso(), connectionId);
      return Response.json(
        {
          ok: false,
          provider: targetProvider,
          status: "failed",
          error: "missing_code",
        } satisfies OAuthCallbackResponse,
        { status: 400 }
      );
    }

    const stateSecret = this.latestSecret(targetProvider, `oauth_state:${targetProvider}:${state}`);
    const statePayload = stateSecret ? this.cipher.decrypt(stateSecret.cipher_blob) : null;
    const codeVerifier = typeof statePayload?.codeVerifier === "string" ? statePayload.codeVerifier : "";

    if (!codeVerifier) {
      this.db
        .query(`UPDATE auth_connections SET status = 'failed', updated_at = ? WHERE id = ?`)
        .run(nowIso(), connectionId);
      return Response.json(
        {
          ok: false,
          provider: targetProvider,
          status: "failed",
          error: "missing_pkce_verifier",
        } satisfies OAuthCallbackResponse,
        { status: 400 }
      );
    }

    const exchange = await this.exchangeCode(targetProvider, config, code, codeVerifier);
    if (!exchange.ok || !exchange.data) {
      this.db
        .query(`UPDATE auth_connections SET status = 'failed', updated_at = ? WHERE id = ?`)
        .run(nowIso(), connectionId);

      return Response.json(
        {
          ok: false,
          provider: targetProvider,
          status: "failed",
          error: exchange.error ?? "oauth_exchange_failed",
        } satisfies OAuthCallbackResponse,
        { status: 400 }
      );
    }

    const applied = this.applySuccessfulAuth(
      targetProvider,
      connectionId,
      String(pendingConnection.account_ref),
      exchange.data
    );

    return Response.json(
      {
        ok: true,
        provider: targetProvider,
        status: "connected",
        accountRef: applied.accountRef,
        expiresAt: applied.expiresAt,
      } satisfies OAuthCallbackResponse,
      {
        headers: {
          "cache-control": "no-store",
        },
      }
    );
  }

  async refreshProvider(provider: string): Promise<Response> {
    const targetProvider = resolveProvider(provider);
    if (!targetProvider) {
      return Response.json({ ok: false, error: "unsupported_provider" }, { status: 404 });
    }

    const config = this.providerConfig(targetProvider);
    if (!config) {
      return Response.json({ ok: true, provider: targetProvider, refreshed: false, reason: "provider_not_configured" });
    }

    const connection = this.latestConnection(targetProvider);
    if (!connection || connection.status !== "connected") {
      return Response.json({ ok: true, provider: targetProvider, refreshed: false, reason: "no_connected_account" });
    }

    const refreshSecret = this.latestSecret(targetProvider, `${targetProvider}:refresh_token:${connection.id}`);
    const refreshPayload = refreshSecret ? this.cipher.decrypt(refreshSecret.cipher_blob) : null;
    const refreshToken = typeof refreshPayload?.token === "string" ? refreshPayload.token : "";

    if (!refreshToken) {
      return Response.json({ ok: true, provider: targetProvider, refreshed: false, reason: "refresh_token_missing" });
    }

    const refreshed = await this.refreshToken(targetProvider, config, refreshToken);
    if (!refreshed.ok || !refreshed.data) {
      return Response.json({ ok: true, provider: targetProvider, refreshed: false, reason: refreshed.error ?? "refresh_failed" });
    }

    const applied = this.applySuccessfulAuth(targetProvider, connection.id, connection.account_ref, refreshed.data);

    return Response.json({
      ok: true,
      provider: targetProvider,
      refreshed: true,
      accountRef: applied.accountRef,
      expiresAt: applied.expiresAt,
    });
  }

  private oauthStatus(provider: OAuthProvider): ProviderStatus {
    const connection = this.latestConnection(provider);
    const config = this.providerConfig(provider);
    const hasAccessToken =
      connection !== null && this.latestSecret(provider, `${provider}:access_token:${connection.id}`) !== null;

    const connected =
      connection !== null && connection.status === "connected" && hasAccessToken && (!connection.expires_at || connection.expires_at > nowIso());

    return {
      provider,
      configured: config !== null,
      connected,
      status: connection?.status ?? "not_connected",
      checkedAt: nowIso(),
      detail: connection?.account_ref,
      expiresAt: connection?.expires_at ?? null,
      refreshSupported: true,
    };
  }

  private async linearStatus(): Promise<ProviderStatus> {
    const linearApiKey = this.env.LINEAR_API_KEY?.trim() ?? "";
    if (linearApiKey.length > 0) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const response = await this.fetchImpl("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: linearApiKey.startsWith("Bearer ") ? linearApiKey : `Bearer ${linearApiKey}`,
          },
          body: JSON.stringify({
            query: "query SquidwardLinearHealth { viewer { id name } }",
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const payload = (await response.json()) as {
          data?: { viewer?: { id?: string; name?: string } };
          errors?: Array<{ message?: string }>;
        };
        const viewer = payload.data?.viewer;
        if (!response.ok || !viewer?.id) {
          return {
            provider: "linear",
            configured: true,
            connected: false,
            status: "api_key_invalid",
            checkedAt: nowIso(),
            detail: payload.errors?.[0]?.message ?? `http_${response.status}`,
            refreshSupported: false,
          };
        }

        return {
          provider: "linear",
          configured: true,
          connected: true,
          status: "api_key_valid",
          checkedAt: nowIso(),
          detail: viewer.name ? `${viewer.name} (${viewer.id})` : viewer.id,
          refreshSupported: false,
        };
      } catch (error) {
        return {
          provider: "linear",
          configured: true,
          connected: false,
          status: "api_key_check_failed",
          checkedAt: nowIso(),
          detail: error instanceof Error ? error.message : "unknown_error",
          refreshSupported: false,
        };
      }
    }
    return this.oauthStatus("linear");
  }

  async getStatus(): Promise<Response> {
    const [gh, codex, linear] = await Promise.all([
      this.runCommand("gh", ["auth", "status"]),
      (async () => {
        const version = await this.runCommand("codex", ["--version"]);
        if (version.exitCode === 0) {
          return version;
        }
        return this.runCommand("codex", ["--help"]);
      })(),
      this.linearStatus(),
    ]);

    const openAiKey = this.env.OPENAI_API_KEY ?? this.env.OPENAI_TOKEN;

    return Response.json({
      ok: true,
      generatedAt: nowIso(),
      providers: {
        slack: this.oauthStatus("slack"),
        linear,
        openai: {
          provider: "openai",
          configured: Boolean(openAiKey),
          connected: Boolean(openAiKey),
          status: openAiKey ? "token_present" : "missing_token",
          checkedAt: nowIso(),
        },
        github: {
          provider: "github",
          configured: gh.exitCode === 0 || (!gh.stderr.includes("not found") && !gh.stderr.includes("ENOENT")),
          connected: gh.exitCode === 0,
          status: gh.exitCode === 0 ? "authenticated" : "unauthenticated",
          checkedAt: nowIso(),
          detail:
            gh.exitCode === 0
              ? sanitizeCommandDetail(gh.stdout) || "gh auth ok"
              : sanitizeCommandDetail(gh.stderr) || "gh auth failed",
        },
        codex: {
          provider: "codex",
          configured:
            codex.exitCode === 0 || (!codex.stderr.includes("not found") && !codex.stderr.includes("ENOENT")),
          connected: codex.exitCode === 0,
          status: codex.exitCode === 0 ? "available" : "unavailable",
          checkedAt: nowIso(),
          detail:
            codex.exitCode === 0
              ? sanitizeCommandDetail(codex.stdout) || "codex available"
              : sanitizeCommandDetail(codex.stderr) || "codex unavailable",
        },
      },
    });
  }
}

export const createIntegrationsService = (options: IntegrationsOptions): IntegrationsService => {
  return new IntegrationsService(options);
};

export type { CommandRunner };
export type { FetchLike };
