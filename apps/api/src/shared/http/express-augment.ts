import type { GuestContext, StaffContext } from "../types/access-context.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      staff?: StaffContext;
      guest?: GuestContext;
    }
  }
}

export {};
