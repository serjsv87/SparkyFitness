import express, { Request, Response, Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import poolManager from '../db/poolManager';
import { log } from '../config/logging';
import crypto from 'crypto';
import {
  telegramStatusResponseSchema,
  telegramLinkCodeResponseSchema,
  TelegramWebhookSchema,
} from '@workspace/shared';
import telegramBotService from '../integrations/telegram/telegramBotService';

const router: Router = express.Router();

interface AuthRequest extends Request {
  user: {
    id: string;
  };
}

/**
 * GET Telegram Link Status
 */
router.get(
  '/status',
  (req: Request, res: Response, next) => authenticate(req, res, next),
  async (req: Request, res: Response) => {
    const userId = (req as AuthRequest).user.id;
    const client = await poolManager.getSystemClient();
    try {
      const result = await client.query(
        'SELECT telegram_chat_id FROM public."user" WHERE id = $1',
        [userId]
      );

      const response = {
        isLinked: !!result.rows[0]?.telegram_chat_id,
        chatId: result.rows[0]?.telegram_chat_id || null,
      };

      // Validate with Zod before sending
      telegramStatusResponseSchema.parse(response);

      res.json(response);
    } catch (error: any) {
      log('error', `Error checking Telegram status: ${error.message}`);
      res.status(500).json({ message: 'Error checking Telegram status' });
    } finally {
      client.release();
    }
  }
);

/**
 * POST Generate Linking Code
 */
router.post(
  '/link-code',
  (req: Request, res: Response, next) => authenticate(req, res, next),
  async (req: Request, res: Response) => {
    const userId = (req as AuthRequest).user.id;
    // Generate a random 6-character code
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const client = await poolManager.getSystemClient();
    try {
      await client.query(
        'UPDATE public."user" SET telegram_link_code = $1 WHERE id = $2',
        [code, userId]
      );

      const response = { code };
      telegramLinkCodeResponseSchema.parse(response);

      res.json(response);
    } catch (error: any) {
      log('error', `Error generating Telegram link code: ${error.message}`);
      res.status(500).json({ message: 'Error generating link code' });
    } finally {
      client.release();
    }
  }
);

/**
 * POST Unlink Telegram
 */
router.post(
  '/unlink',
  (req: Request, res: Response, next) => authenticate(req, res, next),
  async (req: Request, res: Response) => {
    const userId = (req as AuthRequest).user.id;
    const client = await poolManager.getSystemClient();
    try {
      await client.query(
        'UPDATE public."user" SET telegram_chat_id = NULL, telegram_link_code = NULL WHERE id = $1',
        [userId]
      );
      res.json({ message: 'Telegram account unlinked successfully' });
    } catch (error: any) {
      log('error', `Error unlinking Telegram: ${error.message}`);
      res.status(500).json({ message: 'Error unlinking Telegram' });
    } finally {
      client.release();
    }
  }
);

/**
 * POST Telegram Webhook
 * Verified via X-Telegram-Bot-Api-Secret-Token header when TELEGRAM_WEBHOOK_SECRET is set.
 */
router.post('/webhook', (req: Request, res: Response) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const incoming = req.headers['x-telegram-bot-api-secret-token'];
    if (!incoming || incoming !== secret) {
      log('warn', '[TELEGRAM] Webhook rejected: invalid secret token');
      return res.sendStatus(403);
    }
  }

  try {
    const validatedData = TelegramWebhookSchema.parse(req.body);
    telegramBotService.handleUpdate(validatedData);
    res.sendStatus(200);
  } catch (error: any) {
    log('error', `Telegram webhook validation failed: ${error.message}`);
    // Return 200 to prevent Telegram from retrying bad data
    res.sendStatus(200);
  }
});

module.exports = router;
