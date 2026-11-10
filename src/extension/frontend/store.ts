// A minimal observable value plus the Preact hook that reads it. The frontend keeps its own UI
// state here (the page shown, the device's preferences); what LumiAH knows lives only in the
// client's copy of the backend's state. Moved from LumiRPEngine.

import { useEffect, useRef, useState } from "preact/hooks";

export interface Store<T> {
  get(): T;
  set(next: T): void;
  update(fn: (current: T) => T): void;
  subscribe(listener: (value: T) => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  const set = (next: T): void => {
    if (Object.is(next, value)) return;
    value = next;
    for (const listener of [...listeners]) listener(value);
  };
  return {
    get: () => value,
    set,
    update: (fn) => set(fn(value)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Anything with `get` and `subscribe`: a Store, or the client's state. */
export interface Readable<T> {
  get(): T;
  subscribe(listener: (value: T) => void): () => void;
}

/**
 * The selected slice of a store, read on every render (so a selector that closes over a prop is
 * never stale), with a re-render whenever the slice changes identity.
 */
export function useSelect<T, S>(source: Readable<T>, select: (value: T) => S): S {
  const selected = select(source.get());
  const [, bump] = useState(0);
  const last = useRef(selected);
  const selector = useRef(select);
  last.current = selected;
  selector.current = select;
  useEffect(() => {
    const check = (value: T): void => {
      if (!Object.is(selector.current(value), last.current)) bump((n) => n + 1);
    };
    // The store may have changed between the render and this subscription.
    check(source.get());
    return source.subscribe(check);
  }, [source]);
  return selected;
}
