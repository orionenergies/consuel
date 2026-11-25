import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface AuthOptions {
  apiKey: string;
  production: boolean;
}

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

/**
 * Authentification par en-tête `x-api-key`, comme les autres bots Orion.
 * En production, l'absence d'API_KEY bloque les routes protégées (le service est public sur Cloud Run).
 * Hors production, sans API_KEY, l'authentification est désactivée.
 */
export function apiKeyAuth({ apiKey, production }: AuthOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!apiKey) {
      if (!production) {
        next();
        return;
      }
      res.status(503).json({
        status: 'error',
        message: 'API_KEY non configurée côté serveur : accès refusé',
      });
      return;
    }
    if (!production) {
      next();
      return;
    }

    const provided = req.header('x-api-key');
    if (!provided) {
      res.status(401).json({
        status: 'error',
        message: 'Authentification requise : header x-api-key manquant',
      });
      return;
    }
    if (!safeEqual(provided, apiKey)) {
      res.status(403).json({
        status: 'error',
        message: 'Authentification échouée : API Key invalide',
      });
      return;
    }
    next();
  };
}
