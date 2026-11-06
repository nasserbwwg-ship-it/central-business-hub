import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { ApiError } from "./errors.js";
import { allowedOrigins, requireCsrf } from "./auth.js";
import { pool, query } from "./db.js";
import routes from "./routes.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be a valid TCP port.");
}

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new ApiError(403, "مصدر الطلب غير مسموح.", "ORIGIN_FORBIDDEN"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-CSRF-Token"],
  maxAge: 600,
}));
app.use(express.json({ limit: "1mb", strict: true }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }));

app.get("/api/health", async (_request, response) => {
  await query("SELECT 1");
  response.json({ status: "ok", service: "central-hub-api", database: "connected" });
});

app.use("/api", requireCsrf, routes);

const webDistPath = fileURLToPath(new URL("../../web/dist/", import.meta.url));
if (existsSync(webDistPath)) {
  app.use(express.static(webDistPath, { index: false }));
  app.get("/{*path}", (_request, response, next) => {
    response.sendFile(resolve(webDistPath, "index.html"), (error) => {
      if (error) next(error);
    });
  });
}

app.use((request, response) => {
  response.status(404).json({ error: `المسار ${request.path} غير موجود.`, code: "ROUTE_NOT_FOUND" });
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (response.headersSent) {
    return;
  }
  if (error instanceof ApiError) {
    response.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  const candidate = error as { code?: string; type?: string; status?: number };
  if (candidate.code === "23505") {
    response.status(409).json({ error: "يتعارض هذا السجل مع بيانات موجودة.", code: "DUPLICATE_RECORD" });
    return;
  }
  if (candidate.code === "23503" || candidate.code === "23514" || candidate.code === "22P02") {
    response.status(400).json({ error: "تعذّر حفظ البيانات بسبب مرجع أو قيمة غير صالحة.", code: "INVALID_DATABASE_VALUE" });
    return;
  }
  if (candidate.type === "entity.too.large") {
    response.status(413).json({ error: "حجم الطلب أكبر من الحد المسموح.", code: "PAYLOAD_TOO_LARGE" });
    return;
  }
  console.error("Unhandled API error", error);
  response.status(500).json({ error: "حدث خطأ داخلي. راجع سجل الخادم بالوقت المقابل.", code: "INTERNAL_SERVER_ERROR" });
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error", error);
});

async function start(): Promise<void> {
  await pool.query("SELECT 1");
  const server = app.listen(port, host, () => {
    console.log(`Central Business Hub API listening on http://127.0.0.1:${port}`);
  });
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; shutting down API.`);
    server.close((error) => {
      if (error) {
        console.error("Error closing HTTP server", error);
        process.exitCode = 1;
      }
      void pool.end();
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch(async (error: unknown) => {
  console.error("API startup failed", error);
  await pool.end();
  process.exitCode = 1;
});

export { app };
