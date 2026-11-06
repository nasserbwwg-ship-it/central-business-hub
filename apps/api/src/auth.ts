import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { query } from "./db.js";
import { ApiError } from "./errors.js";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "cbh_session";
const CSRF_COOKIE = "cbh_csrf";
const SESSION_LIFETIME_MS = 1000 * 60 * 60 * 12;

export type MembershipRole = "owner" | "admin" | "manager" | "purchaser" | "warehouse" | "accountant" | "sales" | "driver" | "member";
export type CompanyType = "customer" | "supplier" | "service_provider" | "logistics_provider" | "operator";

export type RequestContext = {
  userId: string;
  sessionTokenHash: string;
  companyId: string;
  companyType: CompanyType;
  companyStatus: "pending" | "active" | "suspended";
  role: MembershipRole;
  fullName: string;
  email: string;
};

declare global {
  namespace Express {
    interface Request {
      context?: RequestContext;
    }
  }
}

export const cookieNames = { session: SESSION_COOKIE, csrf: CSRF_COOKIE } as const;
export const allowedOrigins = (
  process.env.CORS_ORIGINS ?? process.env.WEB_ORIGIN ?? process.env.RENDER_EXTERNAL_URL ?? "http://127.0.0.1:5173"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.origin;
  });
export const csrfCookieOptions = {
  httpOnly: false,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
  maxAge: 1000 * 60 * 60 * 12,
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenMatches(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, salt, hash] = stored.split(":");
  if (algorithm !== "scrypt" || !salt || !hash || !/^[a-f0-9]{128}$/i.test(hash)) {
    return false;
  }
  const expected = Buffer.from(hash, "hex");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function issueCookies(response: Response, sessionToken: string, csrfToken: string): void {
  const secure = process.env.NODE_ENV === "production";
  response.cookie(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_LIFETIME_MS,
  });
  response.cookie(CSRF_COOKIE, csrfToken, csrfCookieOptions);
}

export function clearCookies(response: Response): void {
  const secure = process.env.NODE_ENV === "production";
  response.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: "strict", path: "/" });
  response.clearCookie(CSRF_COOKIE, { httpOnly: false, secure, sameSite: "strict", path: "/" });
}

export async function requireCsrf(request: Request, _response: Response, next: NextFunction): Promise<void> {
  const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (!unsafeMethod) {
    next();
    return;
  }

  const origin = request.get("origin");
  const cookieToken = request.cookies?.[CSRF_COOKIE];
  const headerToken = request.get("x-csrf-token");
  if ((origin && !allowedOrigins.includes(origin)) || !cookieToken || !headerToken || !tokenMatches(cookieToken, headerToken)) {
    next(new ApiError(403, "تعذّر التحقق من مصدر الطلب. حدّث الصفحة ثم أعد المحاولة.", "CSRF_REJECTED"));
    return;
  }
  try {
    const sessionToken: unknown = request.cookies?.[SESSION_COOKIE];
    if (typeof sessionToken === "string" && sessionToken.length <= 100) {
      const session = await query<{ csrf_hash: string }>(
        "SELECT csrf_hash FROM sessions WHERE token_hash = $1 AND expires_at > now()",
        [hashToken(sessionToken)],
      );
      if (session.rows[0] && session.rows[0].csrf_hash !== hashToken(cookieToken)) {
        throw new ApiError(403, "تعذّر التحقق من جلسة الطلب.", "CSRF_REJECTED");
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}

export async function authenticate(request: Request, _response: Response, next: NextFunction): Promise<void> {
  try {
    const rawToken: unknown = request.cookies?.[SESSION_COOKIE];
    if (typeof rawToken !== "string" || rawToken.length < 40 || rawToken.length > 100) {
      throw new ApiError(401, "يلزم تسجيل الدخول للمتابعة.", "AUTHENTICATION_REQUIRED");
    }

    const tokenHash = hashToken(rawToken);
    const result = await query<{
      user_id: string;
      session_token_hash: string;
      company_id: string;
      company_type: CompanyType;
      company_status: RequestContext["companyStatus"];
      role: MembershipRole;
      full_name: string;
      email: string;
      expires_at: Date;
    }>(
      `SELECT s.user_id, s.token_hash AS session_token_hash, c.id AS company_id,
              c.type AS company_type, c.status AS company_status, m.role,
              u.full_name, u.email, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN company_memberships m ON m.company_id = s.active_company_id AND m.user_id = u.id
       JOIN companies c ON c.id = s.active_company_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active = true`,
      [tokenHash],
    );
    const session = result.rows[0];
    if (!session) {
      throw new ApiError(401, "انتهت الجلسة أو أنها غير صالحة. سجّل الدخول مجددًا.", "SESSION_EXPIRED");
    }
    request.context = {
      userId: session.user_id,
      sessionTokenHash: session.session_token_hash,
      companyId: session.company_id,
      companyType: session.company_type,
      companyStatus: session.company_status,
      role: session.role,
      fullName: session.full_name,
      email: session.email,
    };
    void query("UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1", [tokenHash]).catch((error: unknown) => {
      console.error("Could not update session activity", error);
    });
    next();
  } catch (error) {
    next(error);
  }
}

export function requireCompany(...types: CompanyType[]) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (!request.context) {
      next(new ApiError(401, "يلزم تسجيل الدخول للمتابعة.", "AUTHENTICATION_REQUIRED"));
      return;
    }
    if (types.length && !types.includes(request.context.companyType)) {
      next(new ApiError(403, "ليس لديك صلاحية تنفيذ هذه العملية من هذه المنصة.", "COMPANY_TYPE_FORBIDDEN"));
      return;
    }
    if (request.context.companyStatus !== "active" && request.context.companyType !== "operator") {
      next(new ApiError(403, "حساب الشركة بانتظار الاعتماد قبل استخدام العمليات.", "COMPANY_NOT_ACTIVE"));
      return;
    }
    next();
  };
}

export function requireRole(...roles: MembershipRole[]) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (!request.context || !roles.includes(request.context.role)) {
      next(new ApiError(403, "ليست لديك الصلاحية اللازمة لتنفيذ هذه العملية.", "ROLE_FORBIDDEN"));
      return;
    }
    next();
  };
}

export function requireOperator(request: Request, _response: Response, next: NextFunction): void {
  if (request.context?.companyType !== "operator") {
    next(new ApiError(403, "هذه العملية متاحة لإدارة المنظومة فقط.", "OPERATOR_REQUIRED"));
    return;
  }
  next();
}
