# MakerCode Arduino — Frontend Prototype

This is the **frontend** for the MakerCode Arduino challenges. It is a **client of
the MakerCode backend** (FastAPI, in the `MakerCode_DEV` repo): the challenge list
and each challenge's starter template come from the backend, and answers are graded
by the backend. This repo carries **no grader of its own** in the integrated flow.

## Front-end features added on top of the avr8js playground
- **Grade button** (top-right `✔ Submit / Grade`) — submits the current code + wiring
  to the backend and shows green PASS / red FAIL.
- Canvas editing: **Delete** a part (+ its wires), **R** rotate, **Ctrl+C / Ctrl+V**
  copy-paste a part.

## How it talks to the backend
Point it at any backend with the `?api=` URL parameter (persisted in
localStorage; defaults to `http://localhost:8000`):

```
http://localhost:5173/?api=https://stingray-app-g8ivf.ondigitalocean.app
```

or set a global before load:

```html
<script>window.API_BASE_URL = "https://your-backend.example.com";</script>
```

It uses exactly three backend endpoints:

| Call | Endpoint | Returns |
|------|----------|---------|
| Challenge list (sidebar) | `GET /api/arduino_questions` | `[{ id, title, difficulty }]` |
| Load a challenge | `GET /api/arduino_question/{id}` | `{ id, title, question, template_code, template_diagram }` |
| Grade a submission | `POST /run_arduino_question` | `{ pass, message, details }` |

`POST /run_arduino_question` body: `{ question_id, code, diagram }` (diagram is the
`diagram.json` string). The backend needs CORS enabled for your frontend origin
(the MakerCode backend already allows all origins).

## Run the prototype locally
```bash
# 1) backend (the MakerCode_DEV repo) — grader + challenge API
python main_app.py                 # http://localhost:8000  (needs Node on PATH for avr8js)

# 2) this frontend
npm install                        # first time
npx vite                           # http://localhost:5173  (web mode)
#   or: npm run dev                # Electron desktop mode
```
Open http://localhost:5173, pick a challenge from the left (it loads from the
backend), complete the wiring + code, and click **✔ Submit / Grade**.

## Notes for whoever builds the real frontend
- The three endpoints above are the whole contract — swap this prototype's UI for
  your own and keep the same calls.
- The challenge id (from the list) is what you pass back as `question_id` when grading.
- The `grader/` folder here is left only for offline experiments; the integrated flow
  does all grading in the backend.
