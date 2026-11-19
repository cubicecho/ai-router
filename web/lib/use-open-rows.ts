import { useState } from 'react';

/** Which rows of a list are open. */
export interface OpenRows<K> {
  /**
   * Whether a row is open.
   *
   * @param key - The row.
   * @returns true once it has been opened and not closed again.
   */
  isOpen: (key: K) => boolean;
  /**
   * Opens or closes a row.
   *
   * @param key - The row.
   * @param isOpen - Whether it is to be open.
   */
  setOpen: (key: K, isOpen: boolean) => void;
}

/**
 * Keeps which rows of a list of `CollapsibleRow`s are open, by key, so any number may be open at once. Every row
 * starts closed.
 *
 * @typeParam K - What a row is keyed by.
 * @returns The rows' open state.
 */
export function useOpenRows<K>(): OpenRows<K> {
  const [opened, setOpened] = useState<ReadonlySet<K>>(() => new Set());
  const setOpen = (key: K, isOpen: boolean) => {
    setOpened((held) => {
      const next = new Set(held);
      if (isOpen) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };
  return { isOpen: (key) => opened.has(key), setOpen };
}
