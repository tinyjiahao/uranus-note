import { useLayoutEffect, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { emptyHistory, reconcileHistory } from "../state/history";
import { onIdentityChange } from "../state/identity";
import { t } from "../state/locale";
let history = emptyHistory();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
onIdentityChange(() => { history = emptyHistory(); emit(); });
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useAppNavigation() {
  const location = useLocation(), action = useNavigationType();
  useLayoutEffect(() => {
    history = reconcileHistory(history, location.pathname + location.search, location.key, action, location.state?.uranusHistoryMove);
    emit();
  }, [location, action]);
}
export function NavigationButtons() {
  const state = useSyncExternalStore(subscribe, () => history), navigate = useNavigate();
  return <span className="app-navigation">
    {([-1, 1] as const).map(delta => <button key={delta} aria-label={t(delta < 0 ? "回退" : "前进")} title={t(delta < 0 ? "回退" : "前进")} disabled={!state.stack[state.pos + delta]} onClick={() => {
      const target = state.pos + delta, entry = state.stack[target];
      if (entry) navigate(entry.url, { state: { uranusHistoryMove: target } });
    }}>{delta < 0 ? <ChevronLeft /> : <ChevronRight />}</button>)}
  </span>;
}
