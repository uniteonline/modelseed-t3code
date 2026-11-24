/* oxlint-disable t3code/no-untranslated-copy -- Modelseed Windows edition uses Russian. */
import { useEffect, useState } from "react";
import type { DesktopBridge, ModelseedBalance } from "@t3tools/contracts";

const rubles = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
const credits = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });

function amount(value: number, rubPerUSD: number | null) {
  if (rubPerUSD === null) return `${credits.format(value)} кр.`;
  return rubles.format((value * rubPerUSD) / 1_000);
}

export function ModelseedBalancePanel({
  readBalance,
}: {
  readBalance: NonNullable<DesktopBridge["modelseedBalance"]>;
}) {
  const [balance, setBalance] = useState<ModelseedBalance | null>();
  const [stale, setStale] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh account totals from the desktop bridge while the sidebar is visible.
  useEffect(() => {
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      const next = await readBalance().catch(() => null);
      pending = false;
      if (!active) return;
      if (next) setBalance(next);
      else setBalance((previous) => previous ?? null);
      setStale(!next);
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [readBalance]);

  return (
    <section
      aria-label="Аккаунт Modelseed"
      className="rounded-md border border-sidebar-border px-2.5 py-2 text-xs group-data-[collapsible=icon]:hidden"
    >
      {balance ? (
        <>
          <p className="mb-1.5 truncate font-medium">{balance.name}</p>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-1">
            <dt className="text-muted-foreground">Баланс</dt>
            <dd className="text-end font-medium tabular-nums">
              {amount(balance.balanceCredits, balance.rubPerUSD)}
            </dd>
            <dt className="text-muted-foreground">Всего потрачено</dt>
            <dd className="text-end tabular-nums">
              {amount(balance.usedCredits, balance.rubPerUSD)}
            </dd>
          </dl>
        </>
      ) : null}
      {stale || !balance ? (
        <p role="status" className="text-muted-foreground">
          {stale ? "Не удалось обновить данные аккаунта." : "Загружаем баланс…"}
        </p>
      ) : null}
    </section>
  );
}
