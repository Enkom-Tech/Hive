import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function ManagedWorkerConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Timeout (ms)" hint="Request timeout in milliseconds (1000–300000).">
        <DraftInput
          value={
            isCreate
              ? String(values?.timeoutMs ?? 15000)
              : String(config.timeoutMs ?? 15000)
          }
          onCommit={(v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n >= 1000 && n <= 300000) {
              if (isCreate) set!({ timeoutMs: n }); else mark("adapterConfig", "timeoutMs", n);
            }
          }}
          immediate
          className={inputClass}
          placeholder="15000"
        />
      </Field>
    </>
  );
}
