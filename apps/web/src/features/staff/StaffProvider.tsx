"use client";
/** Loads the authenticated staff session (/auth/me). Redirects to /login when unauthenticated. */
import type { StaffSessionInfo } from "@restaurant-platform/contracts";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";
import { Spinner } from "../../components/ui";
import { ApiError, staffApi } from "../../lib/api";

interface StaffContextValue {
  me: StaffSessionInfo;
  can: (permission: string) => boolean;
  hasFeature: (feature: string) => boolean;
  logout: () => Promise<void>;
}

const Ctx = createContext<StaffContextValue | null>(null);

export function StaffProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<StaffSessionInfo | null>(null);
  const router = useRouter();
  const t = useTranslations("common");

  useEffect(() => {
    staffApi
      .get<StaffSessionInfo>("/auth/me")
      .then((info) => {
        staffApi.setCsrf(info.csrfToken);
        setMe(info);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/login");
      });
  }, [router]);

  const logout = useCallback(async () => {
    await staffApi.send("POST", "/auth/logout").catch(() => undefined);
    staffApi.setCsrf(null);
    router.replace("/login");
  }, [router]);

  if (!me) return <Spinner label={t("loading")} />;
  return (
    <Ctx.Provider
      value={{
        me,
        can: (p) => me.permissions.includes(p),
        hasFeature: (f) => me.features.includes(f),
        logout,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useStaff(): StaffContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStaff must be used inside StaffProvider");
  return v;
}
