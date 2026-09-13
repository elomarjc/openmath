"""
Typesetting / MathML Presentation Parser.
Converts 2D Math <Equation display="..."> attributes into clean mathematical syntax and LaTeX.
Supports both native Java DagBuilder bridge (when present) and pure Python fallback.
"""

import os
import re
import subprocess
from typing import Optional, List, Tuple, Dict, Any

from .wheeler import worksheet_base64_decode


def _decode_maple_escapes(s: str) -> str:
    """
    Decode Maple XML octal byte escapes such as \\303\\270 -> ø, \\303\\245 -> å, \\303\\246 -> æ.
    Handles multi-byte UTF-8 sequences as well as single-byte characters.
    """
    if not s or '\\' not in s:
        return s
    def _decode_octal(match):
        octals = re.findall(r'\\([0-7]{3})', match.group(0))
        try:
            raw_bytes = bytes(int(o, 8) for o in octals)
            try:
                return raw_bytes.decode('utf-8')
            except UnicodeDecodeError:
                return raw_bytes.decode('latin-1', errors='ignore')
        except Exception:
            return match.group(0)
    return re.sub(r'(?:\\[0-7]{3})+', _decode_octal, s)


class TNode:
    """AST node for Typesetting functions (mrow, mfrac, msup, mn, mo, mi, etc.)."""
    def __init__(self, name: str, args=None, kwargs=None):
        self.name = name
        self.args = args or []
        self.kwargs = kwargs or {}

    def to_math(self) -> str:
        name = self.name.lower()
        if name in ('mn', 'mi'):
            val = self.args[0] if self.args else ""
            return str(val).strip()
        elif name == 'mo':
            op = str(self.args[0]) if self.args else ""
            if op in ('&sdot;', '&InvisibleTimes;'):
                return ' * '
            if op == '&minus;':
                return ' - '
            if op == '&plus;':
                return ' + '
            return f" {op} "
        elif name == 'mfrac':
            num = self.args[0].to_math() if len(self.args) > 0 and isinstance(self.args[0], TNode) else str(self.args[0] if self.args else "")
            den = self.args[1].to_math() if len(self.args) > 1 and isinstance(self.args[1], TNode) else str(self.args[1] if len(self.args) > 1 else "")
            return f"({num.strip()})/({den.strip()})"
        elif name == 'msup':
            base = self.args[0].to_math() if len(self.args) > 0 and isinstance(self.args[0], TNode) else str(self.args[0] if self.args else "")
            exp = self.args[1].to_math() if len(self.args) > 1 and isinstance(self.args[1], TNode) else str(self.args[1] if len(self.args) > 1 else "")
            return f"({base.strip()})^({exp.strip()})"
        elif name == 'msub':
            base = self.args[0].to_math() if len(self.args) > 0 and isinstance(self.args[0], TNode) else str(self.args[0] if self.args else "")
            sub = self.args[1].to_math() if len(self.args) > 1 and isinstance(self.args[1], TNode) else str(self.args[1] if len(self.args) > 1 else "")
            return f"{base.strip()}_{sub.strip()}"
        elif name == 'msqrt':
            inner = "".join(a.to_math() if isinstance(a, TNode) else str(a) for a in self.args).strip()
            return f"sqrt({inner})"
        elif name == 'mfenced':
            parts = [a.to_math() if isinstance(a, TNode) else str(a) for a in self.args]
            return f"({''.join(parts).strip()})"
        elif name == 'mrow':
            parts = [a.to_math() if isinstance(a, TNode) else str(a) for a in self.args]
            return "".join(parts).strip()
        elif name == 'mcomplete':
            if self.args and isinstance(self.args[0], TNode):
                return self.args[0].to_math()
            return str(self.args[0]).strip() if self.args else ""
        else:
            parts = [a.to_math() if isinstance(a, TNode) else str(a) for a in self.args]
            return "".join(parts).strip()

    def to_latex(self) -> str:
        name = self.name.lower()
        if name in ('mn', 'mi'):
            return str(self.args[0] if self.args else "")
        elif name == 'mo':
            op = str(self.args[0]) if self.args else ""
            if op in ('&sdot;', '&InvisibleTimes;'):
                return r' \cdot '
            if op == '&minus;':
                return ' - '
            if op == '&plus;':
                return ' + '
            return f" {op} "
        elif name == 'mfrac':
            num = self.args[0].to_latex() if self.args and isinstance(self.args[0], TNode) else str(self.args[0] if self.args else "")
            den = self.args[1].to_latex() if len(self.args) > 1 and isinstance(self.args[1], TNode) else str(self.args[1] if len(self.args) > 1 else "")
            return f"\\frac{{{num.strip()}}}{{{den.strip()}}}"
        elif name == 'msup':
            base = self.args[0].to_latex() if self.args and isinstance(self.args[0], TNode) else str(self.args[0] if self.args else "")
            exp = self.args[1].to_latex() if len(self.args) > 1 and isinstance(self.args[1], TNode) else str(self.args[1] if len(self.args) > 1 else "")
            return f"{{{base.strip()}}}^{{{exp.strip()}}}"
        elif name == 'msub':
            base = self.args[0].to_latex() if self.args and isinstance(self.args[0], TNode) else str(self.args[0] if self.args else "")
            sub = self.args[1].to_latex() if len(self.args) > 1 and isinstance(self.args[1], TNode) else str(self.args[1] if len(self.args) > 1 else "")
            return f"{{{base.strip()}}}_{{{sub.strip()}}}"
        elif name == 'msqrt':
            inner = "".join(a.to_latex() if isinstance(a, TNode) else str(a) for a in self.args).strip()
            return f"\\sqrt{{{inner}}}"
        elif name == 'mfenced':
            parts = [a.to_latex() if isinstance(a, TNode) else str(a) for a in self.args]
            return f"\\left({''.join(parts).strip()}\\right)"
        elif name == 'mrow':
            parts = [a.to_latex() if isinstance(a, TNode) else str(a) for a in self.args]
            return "".join(parts).strip()
        elif name == 'mcomplete':
            if self.args and isinstance(self.args[0], TNode):
                return self.args[0].to_latex()
            return str(self.args[0]) if self.args else ""
        else:
            parts = [a.to_latex() if isinstance(a, TNode) else str(a) for a in self.args]
            return "".join(parts).strip()


def parse_typesetting(s: str) -> Optional[TNode]:
    """Parse a Typesetting:-name(...) string into a TNode AST."""
    if not s or not s.strip():
        return None

    # Tokenizer
    tokens = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c.isspace():
            i += 1
            continue
        if s[i:i+13] == 'Typesetting:-':
            i += 13
            m = re.match(r'[a-zA-Z0-9_]+', s[i:])
            if m:
                tokens.append(('IDENT', m.group(0)))
                i += len(m.group(0))
                continue
        if c in '(),=':
            tokens.append((c, c))
            i += 1
            continue
        if c == '"':
            i += 1
            str_chars = []
            while i < n and s[i] != '"':
                if s[i] == '\\' and i + 1 < n:
                    i += 1
                    str_chars.append(s[i])
                else:
                    str_chars.append(s[i])
                i += 1
            tokens.append(('STRING', "".join(str_chars)))
            if i < n and s[i] == '"':
                i += 1
            continue
        m = re.match(r'[^(),=\s"]+', s[i:])
        if m:
            tokens.append(('VALUE', m.group(0)))
            i += len(m.group(0))
            continue
        i += 1

    pos = 0

    def parse_expr():
        nonlocal pos
        if pos >= len(tokens):
            return None
        tok_type, tok_val = tokens[pos]
        if tok_type == 'IDENT':
            name = tok_val
            pos += 1
            args = []
            kwargs = {}
            if pos < len(tokens) and tokens[pos][0] == '(':
                pos += 1  # skip '('
                while pos < len(tokens) and tokens[pos][0] != ')':
                    if pos + 1 < len(tokens) and tokens[pos+1][0] == '=':
                        k = tokens[pos][1]
                        pos += 2
                        v = parse_expr()
                        kwargs[k] = v
                    else:
                        arg = parse_expr()
                        if arg is not None:
                            args.append(arg)
                    if pos < len(tokens) and tokens[pos][0] == ',':
                        pos += 1
                if pos < len(tokens) and tokens[pos][0] == ')':
                    pos += 1
            return TNode(name, args, kwargs)
        elif tok_type in ('STRING', 'VALUE'):
            pos += 1
            return tok_val
        else:
            pos += 1
            return tok_val

    parsed = parse_expr()
    return parsed if isinstance(parsed, TNode) else None


def _find_java_bridge() -> Optional[Tuple[str, str]]:
    """Return (java_executable, jars_path) if available on system."""
    potential_jars = [
        os.environ.get("OPENMATH_JARS_DIR", ""),
        os.environ.get("WORKSHEET_JARS_DIR", ""),
    ]
    jars_dir = None
    for p in potential_jars:
        if p and os.path.isdir(p) and os.path.exists(os.path.join(p, "worksheet.jar")):
            jars_dir = p
            break

    if not jars_dir:
        return None

    # Check if java is in PATH
    try:
        res = subprocess.run(["java", "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if res.returncode == 0:
            return ("java", os.path.join(jars_dir, "*"))
    except Exception:
        pass

    return None


_JAVA_BATCH_DECODER_CLASS = None


def _ensure_java_batch_decoder(jars_pattern: str) -> Optional[str]:
    """Compile a high-speed BatchDecoder class into temp directory."""
    global _JAVA_BATCH_DECODER_CLASS
    if _JAVA_BATCH_DECODER_CLASS and os.path.exists(_JAVA_BATCH_DECODER_CLASS):
        return _JAVA_BATCH_DECODER_CLASS

    import tempfile
    tdir = os.path.join(tempfile.gettempdir(), "openmath_batch_decoder")
    os.makedirs(tdir, exist_ok=True)
    class_file = os.path.join(tdir, "BatchDecoder.class")
    if os.path.isfile(class_file):
        _JAVA_BATCH_DECODER_CLASS = tdir
        return tdir

    java_file = os.path.join(tdir, "BatchDecoder.java")

    java_src = """
import java.io.*;

public class BatchDecoder {
    public static void main(String[] args) throws Exception {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
        BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(System.out, "UTF-8"));
        String line;
        while ((line = reader.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) {
                writer.write("\\n");
                continue;
            }
            writer.write("\\n");
        }
        writer.flush();
    }
}
"""
    try:
        with open(java_file, "w", encoding="utf-8") as f:
            f.write(java_src)
        subprocess.run(["javac", "-cp", f".;{jars_pattern}", java_file], cwd=tdir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        _JAVA_BATCH_DECODER_CLASS = tdir
        return tdir
    except Exception:
        return None


def batch_decode_displays(displays: List[str]) -> List[Tuple[str, str]]:
    """
    Decodes a list of base64 display strings from <Equation display="...">.
    Returns list of (math_str, latex_str).
    """
    if not displays:
        return []

    bridge_info = _find_java_bridge()
    if bridge_info:
        java_cmd, jars_pattern = bridge_info
        class_dir = _ensure_java_batch_decoder(jars_pattern)
        if class_dir:
            try:
                proc = subprocess.Popen(
                    [java_cmd, "-cp", f".;{class_dir};{jars_pattern}", "BatchDecoder"],
                    cwd=class_dir,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8"
                )
                in_data = "\n".join(d.strip() for d in displays) + "\n"
                stdout, _ = proc.communicate(input=in_data, timeout=15)
                lines = stdout.splitlines()

                results = []
                for idx, line in enumerate(lines):
                    lprint = line.strip()
                    if not lprint or lprint.startswith("ERROR:"):
                        results.append(("", ""))
                        continue
                    node = parse_typesetting(lprint)
                    if node:
                        m_str = node.to_math()
                        l_str = node.to_latex()
                        # Check if empty placeholder
                        if not m_str or m_str in ('""', "''"):
                            results.append(("", ""))
                        else:
                            results.append((m_str, l_str))
                    else:
                        results.append(("", ""))
                return results
            except Exception:
                pass

    # Pure Python Fallback
    results = []
    for d in displays:
        results.append(decode_display_pure_python(d))
    return results


HTML_ENTITIES = {
    '&uminus0;': '-',
    '&minus;': '-',
    '&plus;': '+',
    '&equals;': '=',
    '&rightarrow;': '->',
    '&comma;': ',',
    '&verbar;': '|',
    '&sdot;': '*',
    '&InvisibleTimes;': '*',
    '&ApplyFunction;': ' ',
    '&DifferentialD;': 'd',
    '&ExponentialE;': 'e',
    '&ImaginaryI;': 'I',
    '&pi;': 'pi',
    '&tau;': 'tau',
    '&omega;': 'omega',
    '&#969;': 'omega',
    '&#960;': 'pi',
    '&#8486;': 'Ohm',
    '&Omega;': 'Omega',
    '&#230;': 'æ',
    '&#8722;': '-',
    '&alpha;': 'alpha',
    '&beta;': 'beta',
    '&gamma;': 'gamma',
    '&theta;': 'theta',
    '&#952;': 'theta',
    '&lambda;': 'lambda',
    '&mu;': 'mu',
    '&phi;': 'phi',
    '&psi;': 'psi',
    '&Delta;': 'Delta',
    '&lsqb;': '[',
    '&rsqb;': ']',
    '&lcub;': '{',
    '&rcub;': '}',
    '&lpar;': '(',
    '&rpar;': ')',
    '&le;': '<=',
    '&ge;': '>=',
    '&ne;': '<>',
    '&approx;': '≈',
    '&infin;': 'infinity',
    '&deg;': '°',
    '&angle;': '∠',
    '&DoubleRightArrow;': '=>',
}

LAYOUT_WORDS = {
    'true', 'false', 'normal', 'center', '2D~Input', '2D~Output', 'italic',
    'unset', 'placeholder', 'baseline', 'axis', 'right', 'left', 'none',
    'auto', 'ColVector', 'RowVector', 'Matrix', 'Times~New~Roman', 'bold'
}


def decode_display_pure_python(display: str) -> Tuple[str, str]:
    """Pure Python extraction of numbers, identifiers, operators, fractions, and superscripts from dotm."""
    if not display:
        return ("", "")
    try:
        dotm = worksheet_base64_decode(display)
        if not dotm:
            return ("", "")
        # Check if empty placeholder line (mi with empty string)
        if "miGF$6#Q!" in dotm or ("Q!" in dotm and "mrow" in dotm and len(dotm) < 150):
            if not re.search(r'Q(?:[0-9]+|[!%\"\(])([0-9\+\-\*\/\.]+)', dotm):
                return ("", "")

        def extract_tokens(s: str):
            toks = []
            i = 0
            n = len(s)
            while i < n:
                if s[i:i+2] in ('/%', '/.', '/+'):
                    i += 2
                    while i < n and s[i] not in ('-', '/'):
                        i += 1
                    continue

                if s[i] == 'Q' and i + 1 < n:
                    len_char = s[i+1]
                    length = ord(len_char) - 33
                    # Maple string tokens in the DAG are strictly terminated with F'
                    if 0 <= length < 120 and i + 2 + length + 2 <= n and s[i+2+length : i+2+length+2] == "F'":
                        val = s[i+2 : i+2+length]
                        i += 2 + length + 2

                        if not val or val in LAYOUT_WORDS:
                            continue
                        if val.endswith('em') or val.endswith('ex') or (val.startswith('[') and val.endswith(']')):
                            continue

                        val = HTML_ENTITIES.get(val, val)
                        val = _decode_maple_escapes(val)
                        val = val.strip()
                        if val:
                            toks.append(val)
                        continue
                i += 1
            return toks

        def clean_toks(toks):
            res = []
            k = 0
            while k < len(toks):
                t = toks[k]
                if t == 'atomic':
                    k += 1
                    continue
                if t == '0' and k + 1 < len(toks) and toks[k+1] == 'atomic':
                    k += 2
                    sub = ""
                    if k < len(toks) and toks[k] not in ('=', '+', '-', '*', '/', ')', '(', ',', ';', ':'):
                        sub = toks[k]
                        k += 1
                    if len(res) >= 2:
                        base = res[-2]
                        sub_name = res[-1]
                        full_sub = f"{sub_name}{sub}" if sub else sub_name
                        res[-2] = f"{base}_{{{full_sub}}}"
                        res.pop()
                    elif res:
                        if sub:
                            res[-1] = f"{res[-1]}_{{{sub}}}"
                        else:
                            res[-1] = f"{res[-1]}_{{0}}"
                    continue
                if t == '*' and res and res[-1] == '*':
                    k += 1
                    continue
                if t == '=' and res and res[-1] == '=':
                    k += 1
                    continue
                res.append(t)
                k += 1

            out = []
            for t in res:
                if t in (',', ';', ':'):
                    if out:
                        out[-1] += t
                    else:
                        out.append(t)
                elif t in (')', ']', '}'):
                    if out and out[-1] in ('(', '[', '{'):
                        out[-1] += t
                    elif out:
                        out[-1] += t
                    else:
                        out.append(t)
                else:
                    out.append(t)
            return " ".join(out).strip()

        # Handle mfrac
        if "mfrac" in dotm:
            m = re.search(r'mfracGF\$[0-9]*[a-zA-Z\(\$\&]*(?:-F#[0-9]*[a-zA-Z\&\(\$]*|-I%mrow[^\-]*)(.*?)(?:-F#[0-9]*[a-zA-Z\'\(\$]*|-I%mrow[^\-]*)(.*?)(?:/(?:%|\.|\+)|-I#mi|$)', dotm)
            if m:
                num_toks = extract_tokens(m.group(1))
                den_chunk = m.group(2)
                msup_m = re.search(r'msupGF\$[0-9]*%(.*?)(?:-F#[0-9]*[a-zA-Z\&\%\$]*|-I%mrow[^\-]*)(.*?)(?:/(?:%|\.|\+)|$)', den_chunk)
                if msup_m:
                    pre_toks = extract_tokens(den_chunk[:msup_m.start()])
                    base_toks = extract_tokens(msup_m.group(1))
                    exp_toks = extract_tokens(msup_m.group(2))
                    base_s = ' '.join(base_toks) if base_toks else '10'
                    exp_s = ' '.join(exp_toks) if exp_toks else ''
                    den_toks = pre_toks + [f"({base_s})^({exp_s})"]
                else:
                    den_toks = extract_tokens(den_chunk)

                num_s = clean_toks(num_toks)
                den_s = clean_toks(den_toks)
                if num_s and den_s:
                    expr = f"({num_s})/({den_s})"
                    return (expr, expr)

        # Handle msup without mfrac
        if "msup" in dotm:
            msup_m = re.search(r'msupGF\$[0-9]*%(.*?)(?:-F#[0-9]*[a-zA-Z\&\%\$]*|-I%mrow[^\-]*)(.*?)(?:/(?:%|\.|\+)|$)', dotm)
            if msup_m:
                pre_toks = extract_tokens(dotm[:msup_m.start()])
                base_toks = extract_tokens(msup_m.group(1))
                exp_toks = extract_tokens(msup_m.group(2))
                post_toks = extract_tokens(dotm[msup_m.end():])
                base_s = ' '.join(base_toks) if base_toks else '10'
                exp_s = ' '.join(exp_toks) if exp_toks else ''
                all_toks = pre_toks + [f"({base_s})^({exp_s})"] + post_toks
                expr = clean_toks(all_toks)
                return (expr, expr)

        toks = extract_tokens(dotm)
        expr = clean_toks(toks)
        return (expr, expr)
    except Exception:
        return ("", "")

