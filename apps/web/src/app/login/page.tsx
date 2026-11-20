"use client";
import type { StaffSessionInfo } from "@restaurant-platform/contracts";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LangToggle } from "../../components/LangToggle";
import { Banner, Button } from "../../components/ui";
import { ApiError, errorKey, staffApi } from "../../lib/api";
import { type FormSubmitEvent, field } from "../../lib/forms";

const HOME_BY_ROLE: Record<string, string> = { kitchen: "/kitchen", waiter: "/floor" };

export default function LoginPage() {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormSubmitEvent) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const me = await staffApi.send<StaffSessionInfo>("POST", "/auth/login", {
        email: field(form, "email"),
        password: field(form, "password"),
      });
      staffApi.setCsrf(me.csrfToken);
      router.replace(HOME_BY_ROLE[me.role] ?? "/tables");
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invalid_credentials"
          ? t("auth.invalid")
          : err instanceof ApiError && err.status === 429
            ? t("auth.rateLimited")
            : err instanceof ApiError && err.code === "no_location_access"
              ? t("auth.noAccess")
              : t(errorKey(err)),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <form
        onSubmit={(e) => void submit(e)}
        className="w-full max-w-sm space-y-4 rounded-[16px] border border-line bg-white p-6"
      >
        <div className="flex items-center justify-between">
          <h1 className="text-[20px] font-bold">{t("auth.title")}</h1>
          <LangToggle />
        </div>
        {error && <Banner>{error}</Banner>}
        <label className="block text-[14px] font-medium">
          {t("auth.email")}
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            className="mt-1 h-11 w-full rounded-[10px] border border-line px-3"
          />
        </label>
        <label className="block text-[14px] font-medium">
          {t("auth.password")}
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="mt-1 h-11 w-full rounded-[10px] border border-line px-3"
          />
        </label>
        <Button type="submit" variant="dark" disabled={busy} className="h-12 w-full">
          {t("auth.submit")}
        </Button>
      </form>
    </main>
  );
}
