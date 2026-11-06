import { Router } from "express";
import { z } from "zod";
import { query } from "./db.js";
import { parse } from "./validation.js";

const router = Router();

router.post("/support/conversations", async (request, response) => {
  const body = parse(z.object({
    visitorName: z.string().trim().min(2).max(120),
    contact: z.string().trim().max(254).optional().default(""),
    topic: z.string().trim().min(2).max(120),
    message: z.string().trim().min(3).max(2000),
  }), request.body);
  const result = await query<{ id: string }>(
    `INSERT INTO support_conversations (visitor_name, contact, topic, message)
     VALUES ($1, NULLIF($2, ''), $3, $4)
     RETURNING id`,
    [body.visitorName, body.contact, body.topic, body.message],
  );
  response.status(201).json({ id: result.rows[0]?.id, message: "تم استلام رسالتك. سيتواصل معك فريق مركز الأعمال قريبًا." });
});

export default router;
