import { setLocale, t, useLocale } from "../state/locale";

export function LanguagePicker() {
  const locale = useLocale();
  return <label className="language-picker">
    <span>{t("界面语言")}</span>
    <select value={locale} onChange={event => setLocale(event.target.value === "en" ? "en" : "zh-CN")}>
      <option value="zh-CN" lang="zh-CN">简体中文</option>
      <option value="en" lang="en">English</option>
    </select>
  </label>;
}
