/** A router name: the rule the server checks, so the form can say so before it asks. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** What a name may hold, as a person reads it. */
export const NAME_HINT = 'Lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit.';
