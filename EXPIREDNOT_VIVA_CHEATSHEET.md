# EXPIREDNOT — Viva / Presentation Cheat Sheet

**Project:** EXPIREDNOT (AI Pharmacy Inventory Intelligence & Expiry Risk System)  
**Live URLs:** Frontend: [https://expired-not.vercel.app](https://expired-not.vercel.app) | Backend: [https://expirednot.onrender.com](https://expirednot.onrender.com)  

---

## 1. Quick Technical Summary

| Component | Exact Technology | Key Fact to State |
| :--- | :--- | :--- |
| **Frontend** | Vanilla JavaScript (ES6+), HTML5, CSS3 | Single-Page App (SPA), zero external UI frameworks, fast performance. |
| **Backend** | Python 3.13, Gunicorn WSGI, `http.server` | REST API on Render, micro-architecture, handles auth, AI, and database. |
| **Database** | SQLite3 (`expirednot.db`) | 7 normalized tables, relational schema, multi-tenant isolation by `user_id`. |
| **AI Engine** | Google Gemini Multimodal REST API | `gemini-1.5-flash` / `gemini-2.5-flash`, temp 0.1, structured JSON extraction. |
| **OCR Status** | **Multimodal Vision AI (NO Tesseract)** | Directly processes visual image bytes; understands 2D invoice table structures. |
| **Auth** | PBKDF2-SHA256 + 6-digit Salted OTP + Google OAuth | 100k hash rounds, 32-byte Bearer session tokens, zero plaintext OTPs. |
| **Email** | Multi-Provider (Resend API $ightarrow$ Gmail SMTP $ightarrow$ Brevo) | Sends real 6-digit verification codes to user inbox. |
| **Deployment** | Vercel (Frontend) + Render (Backend) | Continuous Git deployment from GitHub `main` branch. |

---

## 2. Top 10 Core Files to Know

1. **`server.py`:** Entire backend API server, database initialization, auth routes, Gemini AI parser, and WSGI entrypoint (`server:app`).
2. **`app.js`:** Client-side SPA controller, session management, REST fetch calls, FEFO calculations, and DOM rendering.
3. **`index.html`:** Single-Page HTML file containing Welcome, Auth, Wizard, and Dashboard workspace panels.
4. **`styles.css`:** Custom design system, CSS grid/flexbox layouts, responsive drawer, and golden-yellow active states.
5. **`Procfile`:** Render deployment configuration: `web: gunicorn server:app`.
6. **`requirements.txt`:** Python production dependencies (`gunicorn`, `flask`, `flask-cors`, `google-generativeai`).
7. **`.env.example`:** Configuration template for `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `GMAIL_USER`, and `RESEND_API_KEY`.
8. **`.gitignore`:** Security filter preventing `.env`, `expirednot.db`, and uploaded bills from leaking to GitHub.

---

## 3. "What File Do I Show?" Reference Table

| Teacher Question | Exact File Path | What to Highlight / Explain |
| :--- | :--- | :--- |
| *"Where is your database defined?"* | [`server.py`](file:///Users/vivraj/Desktop/EXPIREDNOT/server.py#L45-L195) | Show `init_db()` function and the `CREATE TABLE` queries for `users`, `bills`, `batches`, `movements`. |
| *"Where is the AI bill extraction called?"* | [`server.py`](file:///Users/vivraj/Desktop/EXPIREDNOT/server.py#L508-L606) | Show `call_gemini_multimodal_bill_parser()` and system prompt enforcing structured JSON and zero hallucination. |
| *"Where do you upload the bill on frontend?"* | [`app.js`](file:///Users/vivraj/Desktop/EXPIREDNOT/app.js#L1856-L1914) | Show `processBillFile()` sending FormData to `/api/bills/analyze`. |
| *"Where is password hashing done?"* | [`server.py`](file:///Users/vivraj/Desktop/EXPIREDNOT/server.py#L214-L228) | Show `hash_password()` and `verify_password()` using `hashlib.pbkdf2_hmac`. |
| *"Where is the FEFO calculation implemented?"* | [`app.js`](file:///Users/vivraj/Desktop/EXPIREDNOT/app.js#L1134-L1180) | Show `calculateDaysRemaining()` and batch sorting by `expiry_date`. |
| *"Where is the dashboard KPI calculation?"* | [`app.js`](file:///Users/vivraj/Desktop/EXPIREDNOT/app.js#L1250-L1350) | Show dynamic sum of `quantity * purchaseRate`, at-risk count, and loss prevented. |
| *"Where is the WSGI entrypoint for Render?"* | [`server.py`](file:///Users/vivraj/Desktop/EXPIREDNOT/server.py#L1312-L1370) | Show `app(environ, start_response)` adapter executed by `gunicorn server:app`. |

---

## 4. 50 Essential Viva Questions & Model Answers

### Category A: Beginner & Conceptual Questions

#### Q1: What is a Frontend?
- **Short Answer:** The user interface layer running in the client's web browser.
- **Better Answer:** The frontend comprises the visual and interactive elements of an application. In EXPIREDNOT, it is implemented with semantic HTML5, Vanilla CSS3, and modern JavaScript to render the user interface, capture bill uploads, and communicate with backend REST APIs.

#### Q2: What is a Backend?
- **Short Answer:** The server-side logic and data processing layer that handles business rules, security, and database operations.
- **Better Answer:** The backend is the server-side environment responsible for handling business logic, authenticating users, managing database transactions, and interfacing with third-party services like Google Gemini AI and email delivery systems.

#### Q3: What is an API?
- **Short Answer:** Application Programming Interface — a structured communication protocol allowing frontend and backend to exchange data.
- **Better Answer:** An API defines a set of endpoints and rules through which different software components interact. In our project, RESTful APIs exchange JSON payloads over HTTP/HTTPS, enabling the JavaScript frontend to perform CRUD operations on our Python backend.

#### Q4: What is a Relational Database?
- **Short Answer:** A structured data store organizing records into tables with defined columns, primary keys, and relationships.
- **Better Answer:** A relational database organizes data into structured tables enforcing schemas, constraints, and referential integrity via primary and foreign keys. We use SQLite3 to maintain strict relations between users, invoices, batches, and audit movements.

#### Q5: What is Authentication vs. Authorization?
- **Short Answer:** Authentication verifies identity; authorization determines access permissions.
- **Better Answer:** Authentication verifies *who* the user is (e.g. validating email/password or Google ID token). Authorization verifies *what* data that authenticated user is permitted to access (e.g. scoping SQL queries strictly to the user's pharmacy `user_id`).

---

### Category B: Project Specific Questions

#### Q6: Why did you choose the pharmacy expiry problem?
- **Short Answer:** Because retail chemists face significant financial losses (3–7% of revenue) and patient safety risks due to expired medicines.
- **Better Answer:** Pharmacy inventory is uniquely time-sensitive. Retail chemists stock thousands of SKUs across multiple batches with distinct expiration dates. Missed distributor return deadlines result in total write-offs, while manual invoice entry leads to neglected records. EXPIREDNOT automates this end-to-end using AI.

#### Q7: What is FEFO?
- **Short Answer:** First-Expired, First-Out — dispensing medicines with the nearest expiration date first.
- **Better Answer:** FEFO is an inventory management strategy in pharmaceutical dispensing where batches with the earliest expiry dates are prioritized for sale before newer stock. Our system automatically sorts batches by expiry date and highlights the exact batch to dispense.

#### Q8: How does EXPIREDNOT handle physical supplier bills?
- **Short Answer:** The chemist uploads a photo or PDF of the invoice; our AI extracts all medicine names, batches, and expiries automatically.
- **Better Answer:** The user uploads an invoice image or PDF to `/api/bills/analyze`. The backend feeds the image bytes to Google Gemini Multimodal AI, which extracts structured JSON without manual typing. The chemist verifies the data on a side-by-side review screen before saving to inventory.

#### Q9: What happens if the AI cannot read a bill clearly?
- **Short Answer:** The system alerts the user and opens a manual review editor with zero fake or guessed data.
- **Better Answer:** We enforce a strict **Zero Dummy Data Policy**. If Gemini returns low confidence or missing fields, the system marks them as `needs_verification` or prompts the user with an alert, allowing manual adjustments on the side-by-side review interface.

#### Q10: How do distributor returns work in EXPIREDNOT?
- **Short Answer:** The system tracks medicines approaching expiry and generates return manifests with calculated credit note values.
- **Better Answer:** Medicines expiring within 60–90 days are flagged in the *Stock Clearance & Returns* panel. The system calculates the total refundable purchase value, groups items by supplier, and logs return movements to track outstanding distributor credit notes.

---

### Category C: Technical & Architecture Questions

#### Q11: Why did you use Vanilla JavaScript instead of React?
- **Short Answer:** To ensure ultra-fast load times, zero bundle overhead, and complete control over DOM rendering.
- **Better Answer:** Vanilla JavaScript eliminates heavyweight framework runtime overhead (virtual DOM diffing, build tooling complexities), resulting in a lightning-fast application with near-zero bundle size. It delivers instant page transitions and high performance on standard pharmacy POS computers.

#### Q12: Why Python for the backend?
- **Short Answer:** Python offers native support for AI/ML SDKs, clean data processing, and built-in HTTP server capabilities.
- **Better Answer:** Python is the industry standard for AI orchestration and data manipulation. Its robust standard library (`http.server`, `hashlib`, `sqlite3`) allowed us to build a secure, lightweight, micro-REST architecture with direct Google Gemini Multimodal integration.

#### Q13: How does the frontend communicate with the backend?
- **Short Answer:** Using native JavaScript `fetch()` calls transmitting JSON and multipart form data over HTTPS.
- **Better Answer:** The frontend uses asynchronous `fetch()` requests. For authentication and data retrieval, it sends JSON payloads with an `Authorization: Bearer <token>` header. For bill capture, it transmits `multipart/form-data` containing binary image files.

#### Q14: What is Gunicorn and why is it used?
- **Short Answer:** A production-grade WSGI HTTP server that runs Python web applications on production servers.
- **Better Answer:** Gunicorn (Green Unicorn) is a production WSGI HTTP server. On Render, it manages worker processes to handle incoming HTTP requests concurrently, routing them through our `server:app` WSGI callable.

#### Q15: How does Single Page Application (SPA) routing work in your project?
- **Short Answer:** Through client-side CSS class toggling (`.view-active` vs `.view-hidden`) managed by JavaScript functions.
- **Better Answer:** Rather than reloading pages from the server, our SPA maintains 4 top-level views in `index.html`. The `showScreen()` function validates the session state and toggles CSS visibility classes with smooth cubic-bezier transitions, maintaining instantaneous navigation.

---

### Category D: Database & Data Modeling Questions

#### Q16: What are the main tables in your SQLite database?
- **Short Answer:** `users`, `otps`, `sessions`, `bills`, `batches`, `movements`, `expenses`, and `notifications`.
- **Better Answer:** The database schema consists of 7 normalized tables: `users` for pharmacy profiles, `otps` for verification codes, `sessions` for Bearer tokens, `bills` for purchase invoices, `batches` for real medicine inventory, `movements` for audit logs, `expenses` for operating costs, and `notifications` for real-time alerts.

#### Q17: What is a Primary Key vs. a Foreign Key in your schema?
- **Short Answer:** A Primary Key uniquely identifies a row in a table; a Foreign Key references a Primary Key in another table to establish relationships.
- **Better Answer:** In our schema, `users.id` is the Primary Key of the user table. In `batches`, `user_id` is a Foreign Key referencing `users.id`, and `bill_id` is a Foreign Key referencing `bills.id`, enforcing strict relational integrity.

#### Q18: How do you prevent one pharmacy from seeing another pharmacy's stock?
- **Short Answer:** By enforcing tenant isolation using `WHERE user_id = ?` on every SQL query.
- **Better Answer:** Every database record includes a `user_id` column. When a request arrives, the backend extracts the authenticated user's ID from the session token and strictly filters all SELECT, INSERT, and UPDATE queries with `WHERE user_id = ?`.

#### Q19: Why store batches separately from medicines?
- **Short Answer:** Because the same medicine can be purchased in multiple batches with different expiry dates, batch numbers, and purchase rates.
- **Better Answer:** A single medicine (e.g. Paracetamol 500mg) arrives in multiple shipments with distinct batch numbers, manufacturing dates, expiration dates, and supplier rates. Normalizing inventory at the batch level is essential to support accurate FEFO dispensing and audit compliance.

#### Q20: How are stock movements logged?
- **Short Answer:** Every purchase, sale, clearance, or return inserts an immutable record into the `movements` table.
- **Better Answer:** Whenever a bill is confirmed or stock is cleared/returned, the system writes an audit entry to `movements` recording the timestamp, medicine name, batch number, quantity change, financial value, and movement type (`Purchased`, `Sold`, `Returned`, `Cleared`).

---

### Category E: AI & Smart Bill Capture Questions

#### Q21: Why Google Gemini instead of traditional OCR like Tesseract?
- **Short Answer:** Gemini is a multimodal visual AI that understands 2D table layout and financial context, whereas traditional OCR only reads isolated characters.
- **Better Answer:** Traditional OCR libraries extract raw text strings line-by-line, losing column alignment and table structure in complex invoice layouts. Google Gemini Multimodal AI visually inspects document geometry, headers, item tables, and tax summaries in a single inference pass, outputting structured JSON directly.

#### Q22: Is Tesseract currently used in your codebase?
- **Short Answer:** No, Tesseract is NOT used. We use Google Gemini Multimodal Vision API directly.
- **Better Answer:** We do not use Tesseract. Instead, we pipe raw invoice image bytes directly to Google Gemini Multimodal Vision REST API, which handles text recognition, spatial table layout analysis, and JSON structuring simultaneously.

#### Q23: How do you prevent Gemini from hallucinating or guessing medicine names?
- **Short Answer:** Through strict system instructions and low temperature (0.1) enforcing exact character reproduction.
- **Better Answer:** Our system prompt explicitly commands the model: *"Extract ONLY what is visibly printed on the invoice document. NEVER invent, hallucinate, or substitute medicine names. Preserve exact printed product characters."* Setting temperature to 0.1 minimizes randomness and ensures deterministic extraction.

#### Q24: What is the fallback cascade if one Gemini model is rate-limited?
- **Short Answer:** The backend automatically iterates through a cascade of models: `gemini-1.5-flash`, `gemini-2.5-flash`, and `gemini-3.5-flash`.
- **Better Answer:** In `call_gemini_multimodal_bill_parser()`, the backend maintains an array of model identifiers. If an HTTP 429 (rate limit) or 404 error occurs on one endpoint, the loop automatically falls back to the next available Gemini model.

#### Q25: How does the side-by-side review feature protect against errors?
- **Short Answer:** It displays the original bill image on the left and an editable extraction table on the right for human verification.
- **Better Answer:** AI provides high-speed extraction, but pharmaceutical dispensing demands 100% accuracy. The side-by-side UI allows the pharmacist to visually verify extracted medicine names, batch numbers, and expiry dates against the original document, editing any discrepancies before saving to the database.

---

### Category F: Authentication & Security Questions

#### Q26: How are user passwords secured?
- **Short Answer:** Passwords are hashed using PBKDF2-HMAC-SHA256 with 100,000 rounds and random 16-byte salts.
- **Better Answer:** Passwords are never stored in plaintext. In `server.py`, `hashlib.pbkdf2_hmac('sha256', password, salt, 100000)` produces a 256-bit cryptographic digest. Verification uses `hmac.compare_digest` to prevent timing attacks.

#### Q27: How are OTPs stored in the database?
- **Short Answer:** OTPs are salted and hashed using SHA-256 before insertion into the `otps` table.
- **Better Answer:** To prevent database exposure risks, generated 6-digit OTPs are combined with an 8-byte salt and hashed with SHA-256 (`hash_otp()`). Only the hash and salt are saved in the `otps` table with a 5-minute expiration timestamp and a 5-attempt threshold.

#### Q28: How does Google OAuth 2.0 work in your backend?
- **Short Answer:** The frontend receives a Google ID token and sends it to `/api/auth/google`, where the backend validates it against Google's `tokeninfo` endpoint.
- **Better Answer:** The frontend utilizes Google Identity Services to authenticate the user. The resulting credential (JWT) is sent to our backend, which validates the signature and email via `https://oauth2.googleapis.com/tokeninfo?id_token=...` before creating a session token.

#### Q29: What type of session tokens do you use?
- **Short Answer:** 32-byte cryptographically secure random hexadecimal Bearer tokens.
- **Better Answer:** We generate session tokens using Python's `secrets.token_hex(32)`. The token is stored in the `sessions` table with an expiration timestamp and transmitted in the `Authorization: Bearer <token>` header for all authenticated requests.

#### Q30: How is CORS handled between Vercel and Render?
- **Short Answer:** The backend dynamically checks the incoming `Origin` header against `ALLOWED_ORIGINS` and sets CORS headers.
- **Better Answer:** `server.py` implements `_set_cors_headers()` to validate the `Origin` header against configured environment origins (`ALLOWED_ORIGINS` or `FRONTEND_URL`), returning `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true`, and handling `OPTIONS` pre-flight requests.

---

### Category G: Deployment & Environment Questions

#### Q31: How is the frontend deployed on Vercel?
- **Short Answer:** Vercel automatically deploys static assets (`index.html`, `app.js`, `styles.css`) directly from the GitHub repository `main` branch.
- **Better Answer:** Vercel connects to our GitHub repository (`viv-raj26/ExpiredNot`). On every git push to `main`, Vercel builds and distributes the static HTML, CSS, and JavaScript files across its global Edge CDN network.

#### Q32: How is the backend deployed on Render?
- **Short Answer:** Render runs a Python Web Service running Gunicorn using the command `web: gunicorn server:app`.
- **Better Answer:** Render monitors the repository `main` branch. When changes are pushed, it installs dependencies from `requirements.txt` and executes the `Procfile` command (`web: gunicorn server:app`), binding Gunicorn to port `10000`.

#### Q33: How does the frontend know which backend URL to connect to?
- **Short Answer:** `app.js` checks `window.location.hostname`. If running locally, it uses relative paths; otherwise, it connects to `https://expirednot.onrender.com`.
- **Better Answer:** In `app.js`, the `API_BASE_URL` constant checks whether the app is running on `localhost` or a local IP. If deployed on Vercel, it routes all API requests directly to the production Render backend at `https://expirednot.onrender.com`.

#### Q34: What is the purpose of `.env.example`?
- **Short Answer:** A safe template showing all required environment variables without exposing sensitive secret values.
- **Better Answer:** `.env.example` documents all required configuration keys (`GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `GMAIL_USER`, `RESEND_API_KEY`) so new developers can configure their local `.env` files without committing live credentials to version control.

#### Q35: What files are excluded in `.gitignore`?
- **Short Answer:** Sensitive `.env` files, SQLite database files (`*.db`), Python caches (`__pycache__`), and uploaded bill media.
- **Better Answer:** `.gitignore` excludes `.env`, `expirednot.db`, `__pycache__/`, `*.pyc`, `api key*`, and `uploads/bills/*` (preserving `.gitkeep`), ensuring zero security leaks and avoiding database conflicts during deployment.

---

### Category H: Advanced Logic & Performance Questions

#### Q36: How is the total inventory value calculated?
- **Short Answer:** By summing the product of quantity and purchase rate across all active batches: $\sum (	ext{quantity} 	imes 	ext{purchase\_rate})$.
- **Better Answer:** In `app.js` and `/api/analytics`, the system iterates over active batches (`quantity > 0`) belonging to the pharmacy and calculates $\sum (	ext{quantity} 	imes 	ext{purchase\_rate})$ for total inventory cost, and $\sum (	ext{quantity} 	imes 	ext{mrp})$ for total retail value.

#### Q37: How is "Loss Prevented" calculated?
- **Short Answer:** By summing the value of all batches that were cleared at a discount or returned to distributors before expiry.
- **Better Answer:** In the `movements` table, all records with type `Returned` or `Cleared` represent stock that would have expired without intervention. The system sums the `value` of these records to report total financial loss prevented.

#### Q38: How does the email OTP fallback mechanism work?
- **Short Answer:** It attempts Resend API first; if unavailable, it falls back to Gmail SMTP SSL, and then to Brevo API.
- **Better Answer:** `send_email_otp()` implements a resilient 3-tier cascade: 1) Resend API (`api.resend.com`), 2) Direct Gmail SMTP over SSL (`smtp.gmail.com:465`), 3) Brevo API. If all external APIs are unconfigured in local development, it logs the OTP to the console.

#### Q39: What is the benefit of keeping the database embedded in SQLite?
- **Short Answer:** Zero external network latency, zero hosting cost, and simple ACID-compliant file-based persistence.
- **Better Answer:** For an independent pharmacy POS system, SQLite provides instant zero-latency query execution, full ACID transactional guarantees, and zero database server management overhead, while keeping the entire stack self-contained.

#### Q40: What happens when a chemist edits an extracted bill item before confirming?
- **Short Answer:** The edited values overwrite the extracted values in `currentCapturedBill` and are committed to the database.
- **Better Answer:** The side-by-side review table in `app.js` allows two-way data binding. When the chemist modifies a medicine name, batch number, or price in the input field, the change updates `currentCapturedBill.items`, which is then posted to `/api/bills/confirm`.

---

### Category I: Edge Cases & Troubleshooting

#### Q41: How does the application handle rate-limiting on OTP requests?
- **Short Answer:** It enforces a 30-second cooldown between resend requests and locks the OTP after 5 failed attempts.
- **Better Answer:** When a user requests an OTP, the backend checks `otps.created_at`. If less than 30 seconds have elapsed, it returns an HTTP 429 with remaining seconds. In `verify-otp`, if `attempts >= 5`, it invalidates the OTP and requires a new code.

#### Q42: What happens if an image upload contains multiple pages or a PDF?
- **Short Answer:** The system accepts PDF, JPG, PNG, and WEBP files, sending the binary data with the appropriate MIME type to Gemini.
- **Better Answer:** `server.py` extracts MIME types and file extensions, saving the file to `uploads/bills/`. Gemini Multimodal Vision natively parses multi-page PDFs and high-resolution images, extracting all visible invoice line items.

#### Q43: How does the system handle medicines with identical names but different pack sizes?
- **Short Answer:** Each batch record stores individual pack sizes (e.g. 10s, 100ml, 15s) alongside the medicine name.
- **Better Answer:** In the `batches` table, records include both `name` and `pack` (e.g. "Amoxicillin 500mg" with pack "10 Tablets" vs "Amoxicillin 125mg" with pack "60ml Syrup"), ensuring distinct tracking and billing.

#### Q44: Why is the temperature parameter in Gemini set to 0.1?
- **Short Answer:** To make AI responses deterministic, factual, and strictly grounded in the image data without creative variation.
- **Better Answer:** Temperature controls randomness in language model outputs. For invoice extraction where financial and pharmaceutical precision is mandatory, a low temperature of 0.1 forces the model to choose the most mathematically probable token directly corresponding to the visible printed characters.

#### Q45: How does the active sidebar highlight work in CSS?
- **Short Answer:** The active tab is styled with a refined golden-yellow gradient and warm amber text to indicate the current view clearly.
- **Better Answer:** `.sidebar-nav-btn.nav-active` uses a warm golden gradient (`linear-gradient(135deg, #fef9c3, #fef08a)`), polished golden border (`#facc15`), and high-contrast charcoal-amber text (`#713f12`), clearly differentiating the active panel without harsh neon colors.

#### Q46: How does the system calculate Low Stock alerts?
- **Short Answer:** It sums the available quantity across all batches of a medicine and alerts if total stock is 15 units or fewer.
- **Better Answer:** In `app.js`, `renderLowStockTable()` groups batches by medicine name and computes $\sum 	ext{quantity}$. Any medicine with a total quantity $\le 15$ units is flagged in the *Low Stock Alert* panel with an auto-calculated reorder recommendation.

#### Q47: What is the role of `sanitize_user()` in `server.py`?
- **Short Answer:** It removes sensitive fields like `password_hash` and `salt` before returning user data to the client.
- **Better Answer:** `sanitize_user()` converts SQLite user rows into dictionaries and explicitly removes `password_hash` and `salt`, ensuring that sensitive cryptographic secrets are never transmitted across the network.

#### Q48: What is the difference between Demo Mode and Real Pharmacy Mode?
- **Short Answer:** Demo Mode loads temporary sample data in-memory without altering or polluting real database records.
- **Better Answer:** When Demo Mode is activated, `app.js` backs up the live `pharmacyDb` state and populates sample bills and batches for presentation. Exiting Demo Mode restores the authentic database state, guaranteeing zero data pollution.

#### Q49: What happens when a user logs out?
- **Short Answer:** The frontend calls `/api/auth/logout`, removes the token from `localStorage`, and redirects to the Welcome screen.
- **Better Answer:** `POST /api/auth/logout` deletes the session token from the SQLite `sessions` table. The frontend clears `localStorage` and `sessionStorage`, resets in-memory data structures, and executes `showScreen('welcomeScreen')`.

#### Q50: What is your plan for scaling this application in the future?
- **Short Answer:** Migrate SQLite to PostgreSQL, add barcode barcode scanner integration, and implement WhatsApp automated expiry alerts.
- **Better Answer:** Future technical roadmap milestones include: 1) Migrating the database layer to PostgreSQL on Supabase for horizontal scaling, 2) Integrating USB/camera barcode scanners for instant POS checkout, and 3) Connecting the WhatsApp Business API to dispatch automated expiry return alerts directly to pharmacy owners.
