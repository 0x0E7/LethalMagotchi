import { useEffect, useState } from 'react';
import type { ReferenceResponse } from '@lethalmagotchi/shared';
import { api } from '../api/client.js';

interface ReferenceState {
  data: ReferenceResponse | null;
  error: string | null;
}

export function useReference(): ReferenceState {
  const [state, setState] = useState<ReferenceState>({ data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    api
      .reference()
      .then((data) => {
        if (!cancelled) setState({ data, error: null });
      })
      .catch((error: Error) => {
        if (!cancelled) setState({ data: null, error: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
