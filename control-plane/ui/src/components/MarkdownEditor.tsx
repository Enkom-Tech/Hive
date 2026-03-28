import { forwardRef, lazy, Suspense, useImperativeHandle, useRef } from "react";
import { cn } from "../lib/utils";
import type { MarkdownEditorProps, MarkdownEditorRef, MentionOption } from "./markdown-editor-types";

export type { MarkdownEditorProps, MarkdownEditorRef, MentionOption } from "./markdown-editor-types";

const LazyMarkdownEditorCore = lazy(() =>
  import("./MarkdownEditorCore").then((m) => ({ default: m.MarkdownEditorCore })),
);

const MarkdownEditorFallback = forwardRef<HTMLTextAreaElement, MarkdownEditorProps>(
  function MarkdownEditorFallback(
    { value, onChange, placeholder, onBlur, className, bordered = true, onSubmit },
    taRef,
  ) {
    return (
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        className={cn(
          "min-h-[200px] w-full resize-y bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring",
          bordered ? "rounded-md border border-border" : "rounded-sm",
          className,
        )}
        onKeyDown={(e) => {
          if (onSubmit && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
    );
  },
);

export const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(function MarkdownEditor(
  props,
  forwardedRef,
) {
  const fallbackTaRef = useRef<HTMLTextAreaElement>(null);
  const coreRef = useRef<MarkdownEditorRef | null>(null);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => {
      if (coreRef.current) {
        coreRef.current.focus();
      } else {
        fallbackTaRef.current?.focus();
      }
    },
  }));

  return (
    <Suspense fallback={<MarkdownEditorFallback ref={fallbackTaRef} {...props} />}>
      <LazyMarkdownEditorCore {...props} ref={coreRef} />
    </Suspense>
  );
});
