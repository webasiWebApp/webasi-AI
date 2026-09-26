import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

// No login by owner's choice: the dashboard URL itself is the secret. Keep the name so
// procedures that must be owner-only are easy to find if a login is added later.
export const protectedProcedure = t.procedure;
