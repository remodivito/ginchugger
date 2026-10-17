# SPDX-License-Identifier: GPL-3.0-or-later
# Oracle for the port of Paperless-ngx correspondent matching (product v2 spec section 10.A, decision 163).
#
# Runs the REAL `matches` and `_split_match` from server/ports/paperless/reference/matching.py (Paperless-ngx commit
# c50c6f5517e3fd8f97fa546ede69a52b622e2b20), lifted out of the module by source so Django need not be installed, with
# the real `safe_regex_search` from reference/regex.py, over a corpus of cases written here. Writes the development
# cases to tests/fixtures/paperless/matching-golden.json and a held-out quarter (chosen by the case id's hash) to
# matching-hidden.json, which is not read while porting.
#
# Run with CPython 3.12, rapidfuzz 3.14.6 and regex 2026.9.10 (Paperless's uv.lock at that commit), in a venv:
#   python -I scripts/paperless-matching-oracle.py
import ast
import hashlib
import json
import re
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
REF = HERE / "server" / "ports" / "paperless" / "reference"
OUT = HERE / "tests" / "fixtures" / "paperless"
COMMIT = "c50c6f5517e3fd8f97fa546ede69a52b622e2b20"

# ---- stubs for the Django parts the two functions touch
django = types.ModuleType("django"); conf = types.ModuleType("django.conf")
conf.settings = types.SimpleNamespace(MATCH_REGEX_TIMEOUT_SECONDS=0.1)
django.conf = conf
sys.modules["django"] = django; sys.modules["django.conf"] = conf
regex_ns = {"__name__": "documents.regex"}
exec(compile((REF / "regex.py").read_text(), str(REF / "regex.py"), "exec"), regex_ns)


class MatchingModel:
    MATCH_NONE, MATCH_ANY, MATCH_ALL, MATCH_LITERAL, MATCH_REGEX, MATCH_FUZZY, MATCH_AUTO = 0, 1, 2, 3, 4, 5, 6


ALGORITHMS = {"none": 0, "any": 1, "all": 2, "literal": 3, "regex": 4, "fuzzy": 5}


class Model:
    def __init__(self, match, algorithm, insensitive):
        self.match, self.matching_algorithm, self.is_insensitive, self.name = match, ALGORITHMS[algorithm], insensitive, "oracle"


class Document:
    def __init__(self, content):
        self.content = content

    def get_effective_content(self):
        return self.content

    def __str__(self):
        return "doc"


source = (REF / "matching.py").read_text()
tree = ast.parse(source)
wanted = {"log_reason", "matches", "_split_match"}
funcs = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
assert {f.name for f in funcs} == wanted, "reference matching.py changed shape"
future = [n for n in tree.body if isinstance(n, ast.ImportFrom) and n.module == "__future__"]
module = ast.Module(body=future + funcs, type_ignores=[])
import logging
ns = {"re": re, "MatchingModel": MatchingModel, "safe_regex_search": regex_ns["safe_regex_search"], "logger": logging.getLogger("paperless.matching"), "__name__": "documents.matching"}
exec(compile(module, str(REF / "matching.py"), "exec"), ns)
matches, split_match = ns["matches"], ns["_split_match"]

# ---- corpus
groups = []  # (algorithm, match, insensitive, [(content)], tag)


def g(algorithm, match, contents, insensitive=True, tag="own"):
    groups.append((algorithm, match, insensitive, list(contents), tag))


# Upstream cases: src/documents/tests/test_matchables.py at the pinned commit (should/no lists merged; the oracle decides).
g("none", "", ["no", "match"], tag="upstream")
g("all", "alpha charlie gamma", ["I have alpha, charlie, and gamma in me", "I have alpha in me", "I have charlie in me", "I have gamma in me", "I have alpha and charlie in me", "I have alphas, charlie, and gamma in me", "I have alphas in me", "I have bravo in me"], tag="upstream")
g("all", "12 34 56", ["I have 12 34, and 56 in me", "I have 12 in me", "I have 34 in me", "I have 56 in me", "I have 12 and 34 in me", "I have 120, 34, and 56 in me", "I have 123456 in me", "I have 01234567 in me"], tag="upstream")
g("all", 'brown fox "lazy dogs"', ["the quick brown fox jumped over the lazy dogs", "the quick brown fox jumped over the lazy  dogs", "the quick fox jumped over the lazy dogs", "the quick brown wolf jumped over the lazy dogs", "the quick brown fox jumped over the fat dogs", "the quick brown fox jumped over the lazy... dogs"], tag="upstream")
g("any", "alpha charlie gamma", ["I have alpha in me", "I have charlie in me", "I have gamma in me", "I have alpha, charlie, and gamma in me", "I have alpha and charlie in me", "I have alphas in me", "I have bravo in me"], tag="upstream")
g("any", "12 34 56", ["I have 12 in me", "I have 34 in me", "I have 56 in me", "I have 12 and 34 in me", "I have 12, 34, and 56 in me", "I have 120, 34, and 56 in me", "I have 123456 in me", "I have 01234567 in me"], tag="upstream")
g("any", '"brown fox" " lazy  dogs "', ["the quick brown fox", "jumped over the lazy  dogs.", "the lazy fox jumped over the brown dogs"], tag="upstream")
g("literal", "alpha charlie gamma", ["I have 'alpha charlie gamma' in me", "I have alpha in me", "I have charlie in me", "I have gamma in me", "I have alpha and charlie in me", "I have alpha, charlie, and gamma in me", "I have alphas, charlie, and gamma in me", "I have alphas in me", "I have bravo in me"], tag="upstream")
g("literal", "12 34 56", ["I have 12 34 56 in me", "I have 12 in me", "I have 34 in me", "I have 56 in me", "I have 12 and 34 in me", "I have 12 34, and 56 in me", "I have 120, 34, and 560 in me", "I have 120, 340, and 560 in me", "I have 123456 in me", "I have 01234567 in me"], tag="upstream")
g("regex", r"alpha\w+gamma", ["I have alpha_and_gamma in me", "I have alphas_and_gamma in me", "I have alpha in me", "I have gamma in me", "I have alpha and charlie in me", "I have alpha,and,gamma in me", "I have alpha and gamma in me", "I have alpha, charlie, and gamma in me", "I have alphas, charlie, and gamma in me", "I have alphas in me"], tag="upstream")
g("regex", "[", ["Don't match this"], tag="upstream")
g("regex", r"(a+)+$", [("a" * 5000) + "X"], tag="upstream")
g("fuzzy", "Springfield, Miss.", ["1220 Main Street, Springf eld, Miss.", "1220 Main Street, Spring field, Miss.", "1220 Main Street, Springfeld, Miss.", "1220 Main Street Springfield Miss", "1220 Main Street, Springfield, Mich."], tag="upstream")
g("all", "alpha charlie gamma", ["I have alpha, charlie, and gamma in me", "I have gamma, charlie, and alpha in me", "I have Alpha, charlie, and gamma in me", "I have gamma, Charlie, and alpha in me", "I have alpha, charlie, and Gamma in me", "I have gamma, charlie, and ALPHA in me"], insensitive=False, tag="upstream")
g("all", "Alpha charlie Gamma", ["I have Alpha, charlie, and Gamma in me", "I have Gamma, charlie, and Alpha in me", "I have Alpha, charlie, and gamma in me", "I have gamma, charlie, and alpha in me", "I have alpha, charlie, and Gamma in me", "I have Gamma, Charlie, and ALPHA in me"], insensitive=False, tag="upstream")
g("all", 'brown fox "lazy dogs"', ["the quick brown fox jumped over the lazy dogs", "the quick brown fox jumped over the lazy  dogs", "the quick Brown fox jumped over the lazy dogs", "the quick brown Fox jumped over the lazy  dogs", "the quick brown fox jumped over the Lazy dogs", "the quick brown fox jumped over the lazy  Dogs"], insensitive=False, tag="upstream")
g("any", "alpha charlie gamma", ["I have alpha in me", "I have Alpha in me", "I have chaRLie in me", "I have gamMA in me", "I have aLPha, cHArlie, and gAMma in me", "I have AlphA and CharlIe in me"], insensitive=False, tag="upstream")
g("any", "Alpha Charlie Gamma", ["I have Alpha in me", "I have Alpha, Charlie, and Gamma in me", "I have alpha in me", "I have ChaRLie in me", "I have GamMA in me", "I have ALPha, CHArlie, and GAMma in me", "I have AlphA and CharlIe in me"], insensitive=False, tag="upstream")
g("any", '"brown fox" " lazy  dogs "', ["the quick brown fox", "jumped over the lazy  dogs.", "the quick Brown fox", "jumped over the lazy  Dogs."], insensitive=False, tag="upstream")
g("literal", "alpha charlie gamma", ["I have 'alpha charlie gamma' in me", "I have 'Alpha charlie gamma' in me", "I have 'alpha Charlie gamma' in me", "I have 'Alpha Charlie Gamma' in me"], insensitive=False, tag="upstream")
g("literal", "Alpha Charlie Gamma", ["I have 'Alpha Charlie Gamma' in me", "I have 'alpha charlie gamma' in me", "I have 'alpha Charlie gamma' in me"], insensitive=False, tag="upstream")
g("regex", r"alpha\w+gamma", ["I have alpha_and_gamma in me", "I have Alpha_and_Gamma in me", "I have alpHAs_and_gaMMa in me"], insensitive=False, tag="upstream")
g("regex", r"Alpha\w+gamma", ["I have Alpha_and_gamma in me", "I have Alphas_and_gamma in me", "I have Alpha_and_Gamma in me", "I have alphas_and_gamma in me"], insensitive=False, tag="upstream")

# Own cases: counterparty names and contract text.
g("literal", "Müller GmbH", ["Agreement between Helix Ltd and Müller GmbH, dated", "MÜLLER GMBH", "Mueller GmbH", "Müller GmbHs", "XMüller GmbH", "Müller GmbH", "Müller\nGmbH"])
g("literal", "Müller GmbH", ["MÜLLER GMBH", "Müller GmbH signs"], insensitive=False)
g("literal", "Société Générale", ["between Société Générale and", "SOCIÉTÉ GÉNÉRALE", "Societe Generale", "Société  Générale", "Société Générale's office", "société générale"])
g("literal", "Société Générale", ["société générale", "Société Générale"], insensitive=False)
g("literal", "Acme Ltd.", ["Acme Ltd. agrees", "Acme Ltd.x", "signed by Acme Ltd.", "Acme Ltd"])
g("literal", "O'Brien & Sons", ["O'Brien & Sons Limited", "O’Brien & Sons", "OBrien & Sons", "o'brien & sons"])
g("literal", "AT&T", ["AT&T Inc", "at&t", "AT & T"])
g("literal", "C++ Labs", ["C++ Labs Ltd", "C Labs"])
g("literal", "(Acme)", ["Party (Acme) agrees", "x(Acme)y", "Acme"])
g("literal", "Acme [UK]", ["Acme [UK] Limited", "Acme UK"])
g("literal", "a.b*c", ["see a.b*c here", "see aXbbbc here"])
g("literal", "Dvořák s.r.o.", ["Dvořák s.r.o. Praha", "DVOŘÁK S.R.O.", "Dvorak s.r.o."])
g("literal", "Ørsted A/S", ["Ørsted A/S and", "ørsted a/s", "Orsted A/S"])
g("literal", "İstanbul Ticaret", ["İstanbul Ticaret A.Ş.", "istanbul ticaret", "ISTANBUL TICARET"])
g("literal", "ΣΟΦΙΑ", ["σοφια ltd", "σοφιας", "ΣΟΦΙΑ", "Σοφία"])
g("literal", "Straße AG", ["STRASSE AG", "straße ag", "STRAẞE AG"])
g("literal", "Kelvin Ltd", ["Kelvin Ltd", "kelvin ltd"])
g("literal", "東京海上", ["東京海上日動火災", "株式会社 東京海上 様", "東京海上"])
g("literal", "Acme 2", ["Acme 2 Ltd", "Acme 23", "Acme 2"])
g("literal", "acme_corp", ["acme_corp_ltd", "acme_corp ltd", "ACME_CORP."])
g("literal", "Helix", ["helix²", "helix́", "helixⅣ", "helix‿", "helix‍"])
g("literal", "Acme Ltd", ["Acme\tLtd", "Acme Ltd", "Acme Ltd"])
g("literal", "   ", ["   ", "anything"])
g("literal", " ", [" ", "a b"])
g("literal", "\x1c", ["\x1c", "a\x1cb"])
g("literal", "﻿", ["﻿", "a﻿b"])
g("literal", " Acme ", ["Acme", " Acme  x"])
g("literal", "𝐀𝐜𝐦𝐞", ["by 𝐀𝐜𝐦𝐞 Ltd", "𝐀𝐜𝐦𝐞𝐱"])
g("literal", "-Acme-", ["x-Acme-y", " -Acme- "])

g("any", "Müller Bau", ["Bau GmbH", "MÜLLER", "Müllers", "Baustelle"])
g("any", '"Société Générale" SG', ["SG Paris", "société générale", "Société\n\tGénérale", "SGX"])
g("any", "Acme+ Ltd.", ["Acme+ Ltd.", "Acme+x", "Ltd.x", "Acme Ltd"])
g("any", '"Acme Ltd', ['"Acme Ltd', 'x"Acme', "Acme Ltd"])
g("any", "O'Brien", ["O'Brien", "o'brien's", "OBrien"])
g("any", "-Acme", ["x-Acme", " -Acme", "-Acme"])
g("any", "Dvořák Ørsted", ["dvořák", "ØRSTED", "Orsted"])
g("any", "\"  spaced   phrase \"", ["spaced phrase", "spaced\n\nphrase", "spacedphrase"])
g("any", "東京 海上", ["東京海上", "東京 x", "海上"])
g("all", "Müller GmbH Berlin", ["Müller GmbH, Berlin", "MÜLLER GMBH BERLIN", "Müller GmbH München"])
g("all", "Société Générale", ["générale société", "Société Générales"])
g("all", "Acme Ltd", ["Acme Ltd", "ACME"], insensitive=False)
g("all", '"lazy dogs" fox', ["lazy\ndogs fox", "lazy dogs fox", "lazy\x1cdogs fox"])
g("all", "a.b", ["a.b", "aXb", "a.bc"])
g("all", "Ab", ["ab"], insensitive=False)
g("none", "Acme", ["Acme", "acme"])
g("none", "Acme", ["Acme"], insensitive=False)
g("any", "   ", ["   "])
g("all", "\t\n", ["\t\n"])

g("regex", r"acme\s+(ltd|limited)", ["ACME   Limited", "Acme\nLtd", "acmeltd", "Acme Ltd", "Acme\x1cLtd"])
g("regex", r"^Acme", ["Acme Ltd", " Acme", "x\nAcme"])
g("regex", r"(?m)^Acme", ["x\nAcme", "x\rAcme", "x Acme"])
g("regex", r"Ltd\.$", ["Acme Ltd.", "Acme Ltd.\n", "Acme Ltd.\n\n", "Acme Ltd.\nx"])
g("regex", r"(?m)Ltd\.$", ["Acme Ltd.\nx", "Acme Ltd.\rx"])
g("regex", r"(?i)acme", ["ACME"], insensitive=False)
g("regex", r"(?P<n>ab)-(?P=n)", ["ab-ab", "ab-ba", "AB-ab"])
g("regex", r"\bMüller\b", ["Herr Müller", "Müllers", "MÜLLER"])
g("regex", r"M\w+ller", ["Müller", "Müller", "M ller"])
g("regex", r"Soci\w+\s+G\w+", ["Société Générale", "Societe Generale", "Soci G"])
g("regex", r"\d{3}-\d{4}", ["٣٣٣-٤٤٤٤", "123-4567", "12-3456", "²²²-²²²²"])
g("regex", r"[A-Z]{2,}\s+AG", ["XY AG", "xy ag", "Xy AG"])
g("regex", r"[A-Z]{2,}\s+AG", ["XY AG", "xy ag"], insensitive=False)
g("regex", r"colou?r", ["color", "colour", "colouur"])
g("regex", r"a{,2}b", ["b", "aab", "a{,2}b"])
g("regex", r"x{2", ["x{2", "xx"])
g("regex", r"]", ["a]b", "ab"])
g("regex", r"a}b", ["a}b", "ab"])
g("regex", r"\p{Lu}\p{Ll}+ GmbH", ["Müller GmbH", "müller gmbh", "MÜLLER GmbH"], insensitive=False)
g("regex", r"(?s)Acme.Ltd", ["Acme\nLtd", "Acme Ltd"])
g("regex", r"Acme.Ltd", ["Acme\nLtd", "Acme\rLtd", "Acme Ltd", "Acme Ltd"])
g("regex", r"\AAcme", ["Acme x", "x\nAcme"])
g("regex", r"Acme\Z", ["x Acme", "Acme\n"])
g("regex", r"(?x) a c m e  # the name", ["acme", "a c m e"])
g("regex", r"(?>acme)", ["acme"])
g("regex", r"acme++", ["acmeee"])
g("regex", r"\w+@acme\.example", ["jo@acme.example", "jö@acme.example", "@acme.example"])
g("regex", r"\bS\.A\.", ["Acme S.A.", "XS.A."])
g("regex", r"[\w-]+ GmbH", ["Müller-Lüdenscheidt GmbH", "  GmbH"])
g("regex", r"[^\d\s]+ Ltd", ["Acme Ltd", "123 Ltd"])
g("regex", r"\x41cme", ["Acme"])
g("regex", r"über", ["über", "uber"])
g("regex", r"Acme\b", ["Acmé", "Acme‍", "Acme‿", "Acme."])
g("regex", r"\s", ["a\x1cb", "a b", "ab"])
g("regex", r"(Acme|Helix) (Ltd|plc)", ["Helix plc", "Helix Inc"])
g("regex", r"\#\ Acme", ["# Acme"])
g("regex", r"[[]x", ["[x", "x"])
g("regex", r"\Bcme", ["Acme", "cme"])
g("regex", r"(?i)stra(ss|ß)e", ["STRASSE", "STRAẞE", "strasse"])
g("regex", r"\N{LATIN SMALL LETTER U WITH DIAERESIS}", ["ü"])
g("regex", r"", ["x"])

g("fuzzy", "Acme Limited", ["ACME Limitd agrees to", "Acme Lmited", "Acne Limited", "Acme Ltd", "acme limited"])
g("fuzzy", "Acme Limited", ["acme limited", "ACME LIMITED"], insensitive=False)
g("fuzzy", "abcdefghij", ["xx abcdefghiX yy", "abcdefghiX", "abcdefgXYZ", "abcdefghij"])
g("fuzzy", "abcdefghijklmnopqrs", ["abcdefghijklmnopqXY", "zz abcdefghijklmnopqrX zz"])
g("fuzzy", "Müller GmbH", ["Mueller GmbH", "Muller GmbH", "MUELLER GMBH", "Müler GmbH"])
g("fuzzy", "Société Générale", ["Societe Generale", "Société Generale", "SOCIÉTÉ GÉNÉRALE S.A."])
g("fuzzy", "Acme, Inc.", ["Acme Inc", "A.c.m.e. Inc", "Acme Ink"])
g("fuzzy", "ACME", ["acme", "ACME"], insensitive=False)
g("fuzzy", "!!!", ["...", "text", ""])
g("fuzzy", "Acme", ["", "..."])
g("fuzzy", "Dvořák", ["Dvorak", "Dvořak", "DVOŘÁK"])
g("fuzzy", "acme_corp", ["acme corp", "acme_corp"])
g("fuzzy", "Acme 🚀 Ltd", ["Acme  Ltd", "Acme Ltd"])
g("fuzzy", "𝐀𝐜𝐦𝐞 Holdings", ["𝐀𝐜𝐦𝐞 Holding", "Acme Holdings"])
g("fuzzy", "The International Business Machines Corporation of Armonk, New York, USA", ["Agreement with The International Business Machine Corporation of Armonk New York USA, dated", "The International Business Machines Corp of Armonk NY"])
g("fuzzy", "Brightwater Analytics Limited", ["This agreement is made between Helix Systems Ltd and Brightwater Analytic Limited.", "Brightwater Analytics Limited", "Brighter Waters Analysis Ltd"])
g("fuzzy", "abcd", ["dcba", "abdc", "abxd"])
g("fuzzy", "Northgate", ["Northgat", "Northgte", "Nrthgate x"])
g("fuzzy", " ", [" ", "x"])
g("fuzzy", "İstanbul", ["istanbul", "ISTANBUL"])
g("fuzzy", "ΣΟΦΙΑΣ", ["σοφιας", "σοφιασ"])

# _split_match cases
splits = ['  some random  words "with   quotes  " and   spaces', 'brown fox "lazy dogs"', '"brown fox" " lazy  dogs "', '"Acme Ltd', 'Acme+ Ltd.', "O'Brien & Sons", '"Société  Générale" Müller', 'a\tb\nc', '""', '" "', 'x "" y', '"a"b"c"', 'C++ (UK) [x] {y} a|b ^$ \\d #&~', '"  "', '東京 "海上 日動"', " Acme Ltd\x1c", '"x y"']

cases = []


def cid(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


for algorithm, match, insensitive, contents, tag in groups:
    for content in contents:
        inputs = {"kind": "matches", "algorithm": algorithm, "match": match, "insensitive": insensitive, "content": content}
        result = bool(matches(Model(match, algorithm, insensitive), Document(content)))
        cases.append({"id": cid(inputs), "tag": tag, **inputs, "expected": result})
for m in splits:
    inputs = {"kind": "split", "match": m}
    cases.append({"id": cid(inputs), "tag": "own", **inputs, "expected": split_match(Model(m, "any", True))})

ids = [c["id"] for c in cases]
assert len(ids) == len(set(ids)), "duplicate case"
meta = {"source": "Paperless-ngx src/documents/matching.py", "commit": COMMIT, "python": sys.version.split()[0],
        "rapidfuzz": __import__("rapidfuzz").__version__, "regex": __import__("regex").__version__,
        "split": "a case is held out when the first hex digit of its id is 0-3 (a quarter)"}
hidden = [c for c in cases if int(c["id"][0], 16) < 4]
dev = [c for c in cases if int(c["id"][0], 16) >= 4]
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "matching-golden.json").write_text(json.dumps({**meta, "cases": dev}, ensure_ascii=False, indent=1) + "\n")
(OUT / "matching-hidden.json").write_text(json.dumps({**meta, "cases": hidden}, ensure_ascii=False, indent=1) + "\n")
print(f"{len(cases)} cases: {len(dev)} development, {len(hidden)} held out")
