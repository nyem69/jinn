"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Config {
  gateway?: { port?: number; host?: string };
  engines?: {
    default?: string;
    claude?: { bin?: string; model?: string; effortLevel?: string };
    codex?: { bin?: string; model?: string };
  };
  connectors?: {
    slack?: { appToken?: string; botToken?: string };
  };
  logging?: {
    level?: string;
    stdout?: boolean;
    file?: boolean;
  };
  [key: string]: unknown;
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        checked ? "bg-blue-600" : "bg-neutral-300"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          checked ? "translate-x-4" : "translate-x-1"
        }`}
      />
    </button>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400 mb-4 mt-8 first:mt-0">
      {title}
    </h3>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-neutral-100 last:border-0">
      <label className="text-sm text-neutral-700">{label}</label>
      <div className="w-64">{children}</div>
    </div>
  );
}

function TextInput({
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full text-sm border border-neutral-200 rounded-lg px-3 py-1.5 bg-white text-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  );
}

function SelectInput({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full text-sm border border-neutral-200 rounded-lg px-3 py-1.5 bg-white text-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export default function SettingsPage() {
  const [config, setConfig] = useState<Config>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  function loadConfig() {
    setLoading(true);
    api
      .getConfig()
      .then((data) => {
        setConfig(data as Config);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadConfig();
  }, []);

  function update(path: string[], value: unknown) {
    setConfig((prev) => {
      const next = structuredClone(prev);
      let obj: Record<string, unknown> = next;
      for (let i = 0; i < path.length - 1; i++) {
        if (!obj[path[i]] || typeof obj[path[i]] !== "object") {
          obj[path[i]] = {};
        }
        obj = obj[path[i]] as Record<string, unknown>;
      }
      obj[path[path.length - 1]] = value;
      return next;
    });
  }

  function handleSave() {
    setSaving(true);
    setFeedback(null);
    api
      .updateConfig(config)
      .then(() =>
        setFeedback({ type: "success", message: "Settings saved successfully" })
      )
      .catch((err) =>
        setFeedback({ type: "error", message: `Failed to save: ${err.message}` })
      )
      .finally(() => setSaving(false));
  }

  function handleReset() {
    setFeedback(null);
    loadConfig();
  }

  if (loading) {
    return (
      <div>
        <div className="mb-8">
          <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
          <p className="text-sm text-neutral-500 mt-1">Gateway configuration</p>
        </div>
        <p className="text-sm text-neutral-400">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <div className="mb-8">
          <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
          <p className="text-sm text-neutral-500 mt-1">Gateway configuration</p>
        </div>
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Failed to load config: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <p className="text-sm text-neutral-500 mt-1">Gateway configuration</p>
      </div>

      {feedback && (
        <div
          className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
            feedback.type === "success"
              ? "bg-green-50 border-green-200 text-green-700"
              : "bg-red-50 border-red-200 text-red-700"
          }`}
        >
          {feedback.message}
        </div>
      )}

      <div className="rounded-xl border border-neutral-200 bg-white px-6 py-2">
        {/* Gateway */}
        <SectionHeader title="Gateway" />
        <Field label="Port">
          <TextInput
            type="number"
            value={String(config.gateway?.port ?? "")}
            onChange={(v) => update(["gateway", "port"], Number(v) || 0)}
            placeholder="7777"
          />
        </Field>
        <Field label="Host">
          <TextInput
            value={config.gateway?.host ?? ""}
            onChange={(v) => update(["gateway", "host"], v)}
            placeholder="127.0.0.1"
          />
        </Field>

        {/* Engines */}
        <SectionHeader title="Engines" />
        <Field label="Default Engine">
          <SelectInput
            value={config.engines?.default ?? "claude"}
            onChange={(v) => update(["engines", "default"], v)}
            options={[
              { value: "claude", label: "Claude" },
              { value: "codex", label: "Codex" },
            ]}
          />
        </Field>
        <Field label="Claude Binary">
          <TextInput
            value={config.engines?.claude?.bin ?? ""}
            onChange={(v) => update(["engines", "claude", "bin"], v)}
            placeholder="claude"
          />
        </Field>
        <Field label="Claude Model">
          <TextInput
            value={config.engines?.claude?.model ?? ""}
            onChange={(v) => update(["engines", "claude", "model"], v)}
            placeholder="claude-sonnet-4-20250514"
          />
        </Field>
        <Field label="Claude Effort Level">
          <SelectInput
            value={config.engines?.claude?.effortLevel ?? "default"}
            onChange={(v) => update(["engines", "claude", "effortLevel"], v)}
            options={[
              { value: "default", label: "Default" },
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ]}
          />
        </Field>
        <Field label="Codex Binary">
          <TextInput
            value={config.engines?.codex?.bin ?? ""}
            onChange={(v) => update(["engines", "codex", "bin"], v)}
            placeholder="codex"
          />
        </Field>
        <Field label="Codex Model">
          <TextInput
            value={config.engines?.codex?.model ?? ""}
            onChange={(v) => update(["engines", "codex", "model"], v)}
            placeholder="codex-mini-latest"
          />
        </Field>

        {/* Connectors */}
        <SectionHeader title="Connectors" />
        <Field label="Slack App Token">
          <TextInput
            type="password"
            value={config.connectors?.slack?.appToken ?? ""}
            onChange={(v) => update(["connectors", "slack", "appToken"], v)}
            placeholder="xapp-..."
          />
        </Field>
        <Field label="Slack Bot Token">
          <TextInput
            type="password"
            value={config.connectors?.slack?.botToken ?? ""}
            onChange={(v) => update(["connectors", "slack", "botToken"], v)}
            placeholder="xoxb-..."
          />
        </Field>

        {/* Logging */}
        <SectionHeader title="Logging" />
        <Field label="Log Level">
          <SelectInput
            value={config.logging?.level ?? "info"}
            onChange={(v) => update(["logging", "level"], v)}
            options={[
              { value: "debug", label: "Debug" },
              { value: "info", label: "Info" },
              { value: "warn", label: "Warn" },
              { value: "error", label: "Error" },
            ]}
          />
        </Field>
        <Field label="Stdout">
          <Toggle
            checked={config.logging?.stdout ?? true}
            onChange={(v) => update(["logging", "stdout"], v)}
          />
        </Field>
        <Field label="File Logging">
          <Toggle
            checked={config.logging?.file ?? false}
            onChange={(v) => update(["logging", "file"], v)}
          />
        </Field>
      </div>

      <div className="flex items-center gap-3 mt-6">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
        <button
          onClick={handleReset}
          className="px-5 py-2 text-sm font-medium text-neutral-600 bg-neutral-100 rounded-lg hover:bg-neutral-200 transition-colors"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
