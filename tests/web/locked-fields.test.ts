import { describe, expect, it } from 'vitest';
import {
  COMMON_LOCKABLE_FIELDS,
  fieldNameOf,
  listedFields,
  lockedFieldsOf,
  withLockedFields,
} from '../../web/agents/locked-fields.ts';

// The agent page locks request fields by writing model.lockedFields into the document, and leaves the rest as stored.

const DOCUMENT = {
  spec: 'cubicecho.agent/2',
  id: 'personal-finance',
  model: { model: 'ollama/qwen3:32b', temperature: 0.3 },
  unknownKey: { kept: true },
};

describe('locking request fields in a document', () => {
  it('reads the fields a document locks, and none from one that names no list', () => {
    expect(lockedFieldsOf(DOCUMENT)).toEqual([]);
    expect(lockedFieldsOf({ model: { lockedFields: ['seed', 3, 'top_p'] } })).toEqual(['seed', 'top_p']);
    expect(lockedFieldsOf('not a document')).toEqual([]);
  });

  it('writes the list into the model and keeps everything else as stored', () => {
    const locked = withLockedFields(DOCUMENT, ['temperature', 'seed']);
    expect(locked).toEqual({ ...DOCUMENT, model: { ...DOCUMENT.model, lockedFields: ['temperature', 'seed'] } });
    expect(DOCUMENT.model).not.toHaveProperty('lockedFields');
  });

  it('leaves the list out when nothing is locked', () => {
    const unlocked = withLockedFields(withLockedFields(DOCUMENT, ['seed']), []);
    expect(unlocked).toEqual(DOCUMENT);
  });

  it('lists the common fields, then any other the document locks, each once', () => {
    expect(listedFields(['seed', 'logit_bias'])).toEqual([...COMMON_LOCKABLE_FIELDS, 'logit_bias']);
  });

  it('takes a typed field name only as a request field is spelled', () => {
    expect(fieldNameOf('  logit_bias ')).toBe('logit_bias');
    expect(fieldNameOf('Logit-Bias')).toBeNull();
    expect(fieldNameOf('')).toBeNull();
  });
});
