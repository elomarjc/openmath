"""
Bridge between Pyodide WebAssembly worker and OpenMath cas_engine.
Serializes CASResult into JSON-compatible dictionaries.
"""
import sys
import os
import traceback
import json
import uuid

# Ensure cas_engine is accessible on path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from cas_engine.engine import CASEngine
from cas_engine.plot_engine import PlotData

_engine = None

def get_engine() -> CASEngine:
    global _engine
    if _engine is None:
        _engine = CASEngine()
    return _engine

def evaluate_expression(expr: str, precision: int = 6) -> dict:
    """
    Evaluate mathematical expression using OpenMath CASEngine
    and return a clean JSON-serializable dictionary.
    """
    engine = get_engine()
    try:
        res = engine.evaluate(expr, precision=precision)
        plot_dict = None
        if getattr(res, 'is_plot', False) and getattr(res, 'plot_data', None):
            raw_pdata = res.plot_data
            p_data = raw_pdata.get('plot_obj', raw_pdata) if isinstance(raw_pdata, dict) else raw_pdata
            curves = []
            for c in getattr(p_data, 'curves', []):
                curves.append({
                    "x": [float(v) for v in c.x_vals if v is not None],
                    "y": [float(v) for v in c.y_vals if v is not None],
                    "label": str(getattr(c, 'label', '') or ''),
                    "color": getattr(c, 'color', None),
                    "style": getattr(c, 'style', '-')
                })
            regions = []
            for r in getattr(p_data, 'regions', []):
                regions.append({
                    "x": [float(v) for v in r.x_vals if v is not None],
                    "y_min": [float(v) for v in r.y_min_vals if v is not None],
                    "y_max": [float(v) for v in r.y_max_vals if v is not None],
                    "color": getattr(r, 'color', '#385a8a'),
                    "alpha": float(getattr(r, 'alpha', 0.5)),
                    "label": str(getattr(r, 'label', '') or '')
                })
            plot_dict = {
                "title": str(p_data.title or ""),
                "x_label": str(p_data.x_label or "x"),
                "y_label": str(p_data.y_label or "y"),
                "x_lim": [float(v) for v in p_data.x_lim] if p_data.x_lim else None,
                "y_lim": [float(v) for v in p_data.y_lim] if p_data.y_lim else None,
                "is_polar": bool(getattr(p_data, 'is_polar', False)),
                "curves": curves,
                "regions": regions
            }

        return {
            "exact_latex": str(getattr(res, 'exact_latex', '') or ''),
            "numeric_latex": str(getattr(res, 'numeric_latex', '') or ''),
            "exact_text": str(getattr(res, 'exact_text', '') or ''),
            "numeric_text": str(getattr(res, 'numeric_text', '') or ''),
            "python_code": str(getattr(res, 'python_code', '') or ''),
            "is_numeric_available": bool(getattr(res, 'is_numeric_available', True)),
            "is_plot": bool(getattr(res, 'is_plot', False)),
            "plot_data": plot_dict,
            "execution_time_ms": round(float(getattr(res, 'execution_time_ms', 0.0)), 2),
            "suppress_output": bool(getattr(res, 'suppress_output', False)),
            "error": None
        }
    except Exception as e:
        return {
            "exact_latex": "",
            "numeric_latex": "",
            "exact_text": "",
            "numeric_text": "",
            "python_code": "",
            "is_numeric_available": False,
            "is_plot": False,
            "plot_data": None,
            "execution_time_ms": 0.0,
            "suppress_output": False,
            "error": f"{type(e).__name__}: {str(e)}"
        }

def reset_workspace() -> dict:
    """Reset the CAS engine namespace and history."""
    engine = get_engine()
    engine.reset()
    return {"status": "success", "message": "Workspace reset successfully."}

def get_variables_list() -> dict:
    """Return dictionary of user-defined variables."""
    engine = get_engine()
    vars_dict = {}
    for k, v in engine.get_variables().items():
        vars_dict[k] = str(v)
    return vars_dict

def get_system_info() -> dict:
    """Return runtime metadata."""
    import sympy
    import numpy
    return {
        "sympy_version": sympy.__version__,
        "numpy_version": numpy.__version__,
        "python_version": sys.version
    }

def parse_worksheet_document(content: str) -> dict:
    """
    Parse .mw, .mv, .json, or plain text worksheet file content.
    Returns dictionary with extracted calculation cells and formatting.
    """
    if not content or not content.strip():
        return {"cells": [], "error": "Document is empty"}

    stripped = content.strip()

    # JSON worksheet support
    if stripped.startswith('[') or stripped.startswith('{'):
        try:
            data = json.loads(stripped)
            cell_list = data if isinstance(data, list) else data.get('cells', [])
            parsed = []
            for c in cell_list:
                inp = c.get("input", "")
                is_sec = bool(c.get("is_section_header", False))
                mode_val = c.get("input_mode", 2 if c.get("mode") == "text" else 0)
                parsed.append({
                    "cell_id": c.get("cell_id") or str(uuid.uuid4())[:8],
                    "execution_idx": c.get("execution_idx", len(parsed) + 1),
                    "input": inp,
                    "input_mode": mode_val,
                    "mode": "section" if is_sec else ("text" if mode_val == 2 else "math"),
                    "is_worksheet_mode": c.get("is_worksheet_mode", True),
                    "spans": c.get("spans", []),
                    "is_section_header": is_sec,
                    "section_title": c.get("section_title", inp if is_sec else ""),
                    "section_level": c.get("section_level", 0),
                    "section_html": c.get("section_html", ""),
                    "is_collapsed": bool(c.get("is_collapsed", False)),
                    "result": c.get("result"),
                    "embedded_images": c.get("embedded_images", {}),
                })
            if parsed:
                return {"cells": parsed, "error": None}
        except Exception:
            pass

    # Native .mw / .mv XML worksheet support
    try:
        from cas_engine.mw_importer import WorksheetIO
        raw_cells = WorksheetIO.load_mw_string(content)
        parsed = []
        for c in raw_cells:
            inp = (c.get('input', '') or '').strip()
            is_sec = bool(c.get('is_section_header', False))
            title = (c.get('section_title', '') or '').strip()
            mode_val = c.get('input_mode', 0)
            mode_str = "section" if is_sec else ("text" if mode_val == 2 else "math")

            res_dict = c.get('result')
            clean_res = None
            if res_dict:
                exact_latex = res_dict.get('exact_latex') or ''
                exact_text = res_dict.get('exact_text') or ''
                if not exact_latex and exact_text:
                    exact_latex = exact_text
                numeric_latex = res_dict.get('numeric_latex') or exact_latex
                numeric_text = res_dict.get('numeric_text') or exact_text
                clean_res = {
                    'exact_latex': exact_latex,
                    'exact_text': exact_text,
                    'numeric_latex': numeric_latex,
                    'numeric_text': numeric_text,
                    'is_plot': bool(res_dict.get('is_plot', False)),
                    'result_type': res_dict.get('result_type', 'Symbolic')
                }

            parsed.append({
                'cell_id': c.get('cell_id') or str(uuid.uuid4())[:8],
                'execution_idx': c.get('execution_idx', len(parsed) + 1),
                'input': inp,
                'input_mode': mode_val,
                'mode': mode_str,
                'is_worksheet_mode': c.get('is_worksheet_mode', True),
                'spans': c.get('spans', []),
                'is_section_header': is_sec,
                'section_title': title or inp,
                'section_level': c.get('section_level', 0),
                'is_collapsed': bool(c.get('is_collapsed', False)),
                'section_bg_colors': c.get('section_bg_colors', []),
                'section_html': c.get('section_html', ''),
                'embedded_images': c.get('embedded_images', {}),
                'result': clean_res,
                'error': c.get('error')
            })

        if parsed:
            return {"cells": parsed, "error": None}
    except Exception:
        pass

    # Plain text fallback: line by line or markdown headers
    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    fallback_cells = []
    for line in lines:
        if line.startswith("#"):
            is_sec = line.startswith("# ") or line.startswith("## ")
            sec_title = line.lstrip("# ")
            fallback_cells.append({
                "cell_id": str(uuid.uuid4())[:8],
                "execution_idx": len(fallback_cells) + 1,
                "input": line,
                "input_mode": 2,
                "mode": "section" if is_sec else "text",
                "is_section_header": is_sec,
                "section_title": sec_title,
                "section_level": 0 if line.startswith("# ") else 1,
                "result": None
            })
        elif not line.startswith("//"):
            fallback_cells.append({
                "cell_id": str(uuid.uuid4())[:8],
                "execution_idx": len(fallback_cells) + 1,
                "input": line,
                "input_mode": 1,
                "mode": "math",
                "is_section_header": False,
                "result": None
            })
    if fallback_cells:
        return {"cells": fallback_cells, "error": None}
    return {"cells": [], "error": "No calculation cells found in document"}


