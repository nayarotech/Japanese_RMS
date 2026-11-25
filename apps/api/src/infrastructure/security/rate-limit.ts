/**
 * Distributed rate limiting (Redis), with an in-memory insurance limiter if Redis is unavailable.
 * Limits are injected so tests can tune them; production values live in DEFAULT_RATE_LIMITS.
 */
import type { NextFunction, Request, Response } from "express";
import type { Redis } from "ioredis";
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { Errors } from "../../shared/errors/app-error.js";

export interface RateLimitRule {
  points: number;
  durationSeconds: number;
}

export interface RateLimitConfig {
  loginPerIp: RateLimitRule;
  loginPerEmail: RateLimitRule;
  guestJoinPerIp: RateLimitRule;
  guestOrderPerSession: RateLimitRule;
  publicReadPerIp: RateLimitRule;
  staffMutationPerSession: RateLimitRule;
  onlineOrderPerIp: RateLimitRule;
  onlineOrderPerPhone: RateLimitRule;
  onlineQuotePerIp: RateLimitRule;
  onlineTrackingPerIp: RateLimitRule;
  menuImageUploadPerSession: RateLimitRule;
  mediaReadPerIp: RateLimitRule;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  loginPerIp: { points: 20, durationSeconds: 600 },
  loginPerEmail: { points: 5, durationSeconds: 300 },
  guestJoinPerIp: { points: 10, durationSeconds: 600 },
  guestOrderPerSession: { points: 10, durationSeconds: 60 },
  publicReadPerIp: { points: 300, durationSeconds: 60 },
  staffMutationPerSession: { points: 120, durationSeconds: 60 },
  // Online ordering anti-spam (public, unauthenticated). Phone keys are hashed before use.
  onlineOrderPerIp: { points: 10, durationSeconds: 600 },
  onlineOrderPerPhone: { points: 5, durationSeconds: 3600 },
  onlineQuotePerIp: { points: 60, durationSeconds: 60 },
  onlineTrackingPerIp: { points: 120, durationSeconds: 60 },
  // Menu photos: uploads are CPU-heavy (re-encoding); reads are many small thumbnails per menu page, often from
  // many guests behind one shop Wi-Fi address, and are normally absorbed by browser/CDN caches (immutable URLs).
  menuImageUploadPerSession: { points: 30, durationSeconds: 600 },
  mediaReadPerIp: { points: 1200, durationSeconds: 60 },
};

export type Limiter = (key: string) => Promise<void>;
export type RateLimiters = Record<keyof RateLimitConfig, Limiter>;

export function createRateLimiters(
  redis: Redis,
  config: RateLimitConfig,
  prefix = "rl",
): RateLimiters {
  const make = (name: keyof RateLimitConfig): Limiter => {
    const rule = config[name];
    const limiter = new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: `${prefix}:${name}`,
      points: rule.points,
      duration: rule.durationSeconds,
      insuranceLimiter: new RateLimiterMemory({
        points: rule.points,
        duration: rule.durationSeconds,
      }),
    });
    return async (key: string) => {
      try {
        await limiter.consume(key);
      } catch (err) {
        if (err instanceof RateLimiterRes)
          throw Errors.rateLimited(Math.ceil(err.msBeforeNext / 1000));
        throw err;
      }
    };
  };
  return {
    loginPerIp: make("loginPerIp"),
    loginPerEmail: make("loginPerEmail"),
    guestJoinPerIp: make("guestJoinPerIp"),
    guestOrderPerSession: make("guestOrderPerSession"),
    publicReadPerIp: make("publicReadPerIp"),
    staffMutationPerSession: make("staffMutationPerSession"),
    onlineOrderPerIp: make("onlineOrderPerIp"),
    onlineOrderPerPhone: make("onlineOrderPerPhone"),
    onlineQuotePerIp: make("onlineQuotePerIp"),
    onlineTrackingPerIp: make("onlineTrackingPerIp"),
    menuImageUploadPerSession: make("menuImageUploadPerSession"),
    mediaReadPerIp: make("mediaReadPerIp"),
  };
}

export function limitByIp(limiter: Limiter) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    await limiter(req.ip ?? "unknown");
    next();
  };
}
