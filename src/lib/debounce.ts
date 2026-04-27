export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  wait: number,
): {
  (...args: Args): void;
  flush: () => void;
  cancel: () => void;
} {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Args | null = null;

  const debounced = (...args: Args) => {
    lastArgs = args;
    if (handle != null) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      if (lastArgs) fn(...lastArgs);
      lastArgs = null;
    }, wait);
  };

  debounced.flush = () => {
    if (handle != null) {
      clearTimeout(handle);
      handle = null;
      if (lastArgs) fn(...lastArgs);
      lastArgs = null;
    }
  };

  debounced.cancel = () => {
    if (handle != null) {
      clearTimeout(handle);
      handle = null;
    }
    lastArgs = null;
  };

  return debounced;
}
