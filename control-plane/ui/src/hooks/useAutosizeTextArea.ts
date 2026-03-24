import { useCallback, useEffect, type RefObject } from "react";

export function useAutosizeTextArea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  active: boolean,
) {
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref]);

  useEffect(() => {
    if (active) resize();
  }, [active, value, resize]);

  return resize;
}
