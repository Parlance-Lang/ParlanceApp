# Coach signal server

Independent, free grammar signals that vote with the LLM in the Coach panel ([#40](https://github.com/Parlance-Lang/ParlanceApp/issues/40)). Firebase `coachPanel` sends the text plus free-tier LLM edits to `POST /panel`. This server adds its own candidates and returns the combined verdict. No LLM keys live here.

| Signal | File | Notes |
|---|---|---|
| LanguageTool | `signals/languagetool.py` | Self-hosted via compose; public API for development |
| Agreement (spaCy parse) | `signals/agreement.py` | Gender/number/person mismatches between linked words |
| LLM edits | `app.py` | Verified by a second free model: 0.8, unverified: 0.5 |

`combiner.py` groups overlapping candidates and scores 1 − Π(1 − cᵢ), one vote per source. Thresholds and per-source scales live in `combiner_weights.json`, to be refit from the benchmark.

## Local

```bash
cd services/coach-signals
python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m spacy download es_core_news_sm fr_core_news_sm en_core_web_sm  # one at a time
.venv/bin/uvicorn app:app --port 8080
python3 ../../training/coach_benchmark/eval_panel.py          # signals only
GROQ_API_KEY=... python3 ../../training/coach_benchmark/eval_panel.py --llm
```

## Deploy (free VM)

```bash
SIGNALS_TOKEN=$(openssl rand -hex 24) docker compose up -d
firebase functions:secrets:set COACH_SIGNALS_TOKEN     # same token
# functions/.env: COACH_SIGNALS_URL=https://<vm-host>
```

Put HTTPS in front (Caddy or a Cloudflare Tunnel, both free).
