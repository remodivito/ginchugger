# Known differences: ported Paperless-ngx code

Product v2 spec section 10, step A.5: anything the port does not reproduce, with the reason. The port is
`server/ports/paperless/matching.js`, from Paperless-ngx `src/documents/matching.py` at commit
`c50c6f5517e3fd8f97fa546ede69a52b622e2b20`.

## Correspondent matching

Reference outputs: 434 cases from the real Python (`scripts/paperless-matching-oracle.py`; CPython 3.12.15,
rapidfuzz 3.14.6, regex 2026.9.10). Development set 299 cases, 299 pass. Held-out set 135 cases, run once after the
port was finished (15 October 2026): 134 pass (99.3%).

| Case | Mode | What differs | Why |
|---|---|---|---|
| held-out `0caee26099ab235d` | REGEX | `\N{LATIN SMALL LETTER U WITH DIAERESIS}` matches in Python, refused here | JavaScript has no named-character escape and the port carries no Unicode name table. The pattern is refused, so it never matches; `validateRegexPattern` gives the reason for the counterparty page. |

Differences by design, not in the reference set as failures:

- **Python syntax JavaScript cannot express is refused, not approximated** (REGEX mode): inline flags other than
  `i`, `m`, `s`, `x`, `u` at the start of the pattern; inline flags in the middle of a pattern and scoped flags
  `(?i:…)`; conditionals `(?(1)…)`; recursion and subroutine calls; `\N{…}`, `\g<…>`, `\K`, `\G`, `\X`, `\R`, `\h`,
  `\m`, `\M` and other letter escapes; `\W` inside a character class; POSIX classes `[[:alpha:]]`; fuzzy matching
  `{e<=1}`. A refused pattern does not match and is logged, as Paperless treats an invalid pattern.
- **Atomic groups and possessive quantifiers** are emulated with a lookahead and a back-reference (`(?=(X))\1`), which
  is exactly atomic; group numbers are renumbered so Python's `\1` still names the right group.
- **Time guard**: the 0.1-second limit runs the JavaScript regex in a `vm` context with a timeout. Timings differ
  from Python's `regex` module, so a pattern near the limit can time out in one and not the other.
- **Dotted and dotless I under case-insensitive REGEX**: the `regex` module pairs `i` with `İ` and `I` with `ı` but not
  `İ` with `I`; JavaScript pairs only `i` and `I`. The ANY, ALL and LITERAL modes (Python `re`, where all four letters
  are one class) are exact, by mapping `İ` and `ı` to `i` on both sides when case-insensitive.
- **Unicode version**: the classes are spelled with Unicode properties; Python 3.12 uses Unicode 15.0, the `regex`
  module Unicode 17 and Node 22 Unicode 16. An exhaustive comparison over every code point found differences only in
  characters assigned after Unicode 15.0 (none occur in contract text).
- **FUZZY with a needle longer than 64 characters**: rapidfuzz's C++ code switches to a matching-blocks heuristic
  for long needles, which may miss the best alignment; the port scores every alignment (rapidfuzz's pure-Python
  implementation, which is exact). The port can therefore find a match the C++ misses when both the counterparty
  name and the text exceed 64 characters. The one long-needle reference case (a 70-character name) agrees.
- **Not run**: the spec's review by a second model family (step A.6) needs a live model call, which this slice does not
  make. It is open.

## Mail consumer (server/ports/paperless/mail.js, slice S8)

All 65 ported Paperless-ngx tests pass (`tests/paperless-mail.test.js`: 41 from `test_mail.py` TestMail, 3 host-pinning, 3 NFC, 18 `is_public_ip` cases; `test_filename_filter` and `test_filters` keep their 9 and 8 subcases, 17 more, all passing). Not ported, because they test Django, Celery or several accounts: the post-consume, error-callback, management-command, task, API-view and rule-API tests, and `test_error_skip_account`. Differences from the Python, by design rather than by failure:

- Gmail labels: the path is ported and tested on the rule directly, but left disabled: the imapflow adapter learns capabilities only after login and never reports `X-GM-EXT-1`, so `handle_mail_account` never takes it (spec 10.B.4).
- `test_handle_mail_account_tag_gmail` counts messages without the label (3 before, 1 after) where Paperless's fake treats its "processed" keyword as a label (2 before); the fake here keeps keywords and labels apart, as Gmail does.
- `_process_eml` keeps the message as received: Paperless moves the From header to the top for libmagic, which is not used here.
- `pathvalidate.sanitize_filename` is approximated (invalid and control characters, trailing dots and spaces, reserved device names, 255 bytes).
- `apply_mail_action` takes the open mailbox instead of opening its own connection; the Celery chord and error callback are the caller's (server/mail/consumer.js applies the action after storing, and moves a failed message to "Not filed" where Paperless leaves it in place for a retry).
- UIDVALIDITY is stored as a number (0 for "not reported") where Paperless stores a nullable string; 0 is treated as Paperless treats NULL.
