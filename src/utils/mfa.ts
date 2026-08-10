/**
 * MFA-aware helpers for the CLI's dashboard-session (JWT) calls.
 *
 * Why this exists
 * ───────────────
 * `sankofa login` mints its session JWT from `POST /cli-auth` — email +
 * password only. That token carries no `mfa_verified_at` claim, so the
 * server's post-auth MFA enforcer 403s every org-scoped request for an
 * organisation whose MFA policy applies to the user:
 *
 *   GET /api/projects?org_id=<mfa-org>
 *     → 403 {"error":"mfa_required", "message":"..."}
 *
 * The enforcer is org-scoped: the same session lists projects fine for
 * orgs without a policy, which is why this looked like "some orgs have
 * no projects" rather than an auth failure.
 *
 * The fix is the same one the dashboard performs: POST the TOTP (or a
 * recovery) code to `/api/v1/auth/mfa/verify`, which mints a REPLACEMENT
 * JWT carrying `mfa_verified_at`. Callers must adopt that token for the
 * rest of the flow — the subsequent Deploy-Token mint is org-scoped too
 * and would otherwise hit the identical 403.
 *
 * `/api/v1/auth/mfa/*` is on the enforcer's exit-route allowlist, so the
 * verify call itself is reachable while the challenge is outstanding.
 */

/** Server error envelope for a challenge the client must clear. */
export interface MFAChallenge {
  /** `mfa_required` (enrolled, needs a fresh code) or `mfa_enrollment_required`. */
  code: string;
  message: string;
}

/** Result of an MFA-aware call: the data plus the token that should be used from here on. */
export interface MFAAwareResult<T> {
  data: T;
  /** Same as the input token unless a challenge was solved, in which case it's the refreshed JWT. */
  token: string;
}

interface JsonResponse {
  ok: boolean;
  status: number;
  body: any;
}

async function getJSON(endpoint: string, token: string, path: string): Promise<JsonResponse> {
  const res = await fetch(`${endpoint}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text || null;
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Recognise the enforcer's challenge envelope. Returns null for any other
 * response so genuine failures (403 from a different check, 500, …) keep
 * their own error path instead of prompting for a code that can't help.
 */
export function asMFAChallenge(res: JsonResponse): MFAChallenge | null {
  if (res.status !== 403 || !res.body || typeof res.body !== 'object') return null;
  const code = String(res.body.error || '');
  if (code !== 'mfa_required' && code !== 'mfa_enrollment_required') return null;
  return { code, message: String(res.body.message || '') };
}

/**
 * Turn a non-OK response into a message that names the actual failure.
 * Anything is better than the old behaviour, which mapped every error to
 * an empty list and reported "No projects found".
 */
export function describeHTTPError(res: JsonResponse, what: string): string {
  const serverMsg =
    res.body && typeof res.body === 'object'
      ? res.body.message || res.body.error
      : typeof res.body === 'string'
        ? res.body.slice(0, 200)
        : '';
  if (res.status === 401) return `${what}: session rejected (401). Run \`sankofa login\` to refresh.`;
  return serverMsg ? `${what}: ${serverMsg} (HTTP ${res.status})` : `${what}: HTTP ${res.status}`;
}

/**
 * Exchange a TOTP / recovery code for a refreshed JWT.
 *
 * TOTP codes are exactly 6 digits (server-enforced); recovery codes are
 * base32 `XXXXX-XXXXX` (dashes optional, case-insensitive). The shapes
 * can't collide, so we route on the input rather than asking the user
 * which kind they're holding.
 */
export async function verifyMFACode(
  endpoint: string,
  token: string,
  input: string,
): Promise<string> {
  const value = input.trim();
  const payload = /^\d{6}$/.test(value) ? { code: value } : { recovery_code: value };

  const res = await fetch(`${endpoint}/api/v1/auth/mfa/verify`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* fall through to the status-based message */
  }

  if (!res.ok) {
    const msg = (body && (body.message || body.error)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (!body?.token) {
    // Verified but no replacement token — the server only omits it when
    // the user row vanished mid-request. Retrying with the old token
    // would loop on the same 403, so fail loudly instead.
    throw new Error('server accepted the code but returned no refreshed session token');
  }
  return body.token as string;
}

/**
 * Prompt for a code and clear an outstanding MFA challenge. Returns the
 * refreshed JWT. Gives the user 3 attempts (typos and just-rolled TOTP
 * windows are common) before giving up.
 */
export async function solveMFAChallenge(
  endpoint: string,
  token: string,
  challenge: MFAChallenge,
  orgLabel: string,
  chalk: any,
): Promise<string> {
  if (challenge.code === 'mfa_enrollment_required') {
    // Enrollment needs the QR/secret exchange plus recovery-code capture —
    // a dashboard flow. Point there rather than half-implementing it here.
    // We don't derive a dashboard URL from `endpoint`: self-hosters run the
    // dashboard wherever they like, and guessing would send them nowhere.
    throw new Error(
      `${orgLabel} requires multi-factor authentication and your account is not enrolled yet.\n` +
        '  Enroll in your Sankofa dashboard under Profile → Two-step verification\n' +
        '  (app.sankofa.dev → /dashboard/profile/mfa), then re-run this command.',
    );
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      `${orgLabel} requires multi-factor authentication, and there is no TTY to prompt for a code.\n` +
        '  For CI, use a Deploy Token: `sankofa login --deploy-token <sk_deploy_...> --project-id <id>`.',
    );
  }

  const inquirer = (await import('inquirer')).default;
  console.log('');
  console.log(chalk.yellow(`  ${orgLabel} requires multi-factor authentication.`));

  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { mfaCode } = await inquirer.prompt([
      {
        type: 'input',
        name: 'mfaCode',
        message: attempt === 1
          ? 'Authentication code (or a recovery code):'
          : `Authentication code (${lastError}) — attempt ${attempt}/3:`,
        validate: (v: string) =>
          v.trim().length > 0 ? true : 'Enter the 6-digit code from your authenticator app.',
      },
    ]);
    try {
      const refreshed = await verifyMFACode(endpoint, token, mfaCode);
      console.log(chalk.green('  ✔ MFA verified'));
      return refreshed;
    } catch (err: any) {
      lastError = err.message || 'invalid code';
      if (attempt === 3) {
        throw new Error(`MFA verification failed: ${lastError}`);
      }
    }
  }
  /* unreachable — the loop either returns or throws */
  throw new Error('MFA verification failed');
}

/**
 * List an organisation's projects, transparently clearing an MFA
 * challenge if the org's policy demands one.
 *
 * Returns both the projects AND the token to use from here on: when a
 * challenge was solved the original JWT is superseded, and every later
 * org-scoped call (Deploy-Token mint, stored `sessionJwt`) must carry the
 * refreshed one or it will hit the same 403.
 */
export async function listOrgProjects(
  endpoint: string,
  token: string,
  orgId: string,
  orgLabel: string,
  chalk: any,
  /**
   * Called once, immediately before an interactive MFA prompt. Callers with a
   * live spinner pass `() => spinner.stop()` — an ora spinner and an inquirer
   * prompt both own the cursor, and leaving the spinner running garbles the
   * code entry.
   */
  onBeforePrompt?: () => void,
): Promise<MFAAwareResult<any[]>> {
  const path = `/api/projects?org_id=${encodeURIComponent(orgId)}`;

  let activeToken = token;
  let res = await getJSON(endpoint, activeToken, path);

  const challenge = asMFAChallenge(res);
  if (challenge) {
    onBeforePrompt?.();
    activeToken = await solveMFAChallenge(endpoint, activeToken, challenge, orgLabel, chalk);
    res = await getJSON(endpoint, activeToken, path);
  }

  if (!res.ok) {
    throw new Error(describeHTTPError(res, 'Failed to list projects'));
  }
  if (!Array.isArray(res.body)) {
    throw new Error(
      `Failed to list projects: unexpected response shape from ${endpoint}/api/projects`,
    );
  }
  return { data: res.body, token: activeToken };
}
