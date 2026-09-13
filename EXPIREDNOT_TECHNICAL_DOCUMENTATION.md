# EXPIREDNOT — Complete Project Technical Audit & Viva Guide

**Project Name:** EXPIREDNOT (Pharmacy Inventory Intelligence & Expiry Risk Mitigation System)  
**Domain:** Community & Retail Pharmacy Inventory Management (India Focus)  
**Repository:** `viv-raj26/ExpiredNot` (Branch: `main`)  
**Production Frontend:** [https://expired-not.vercel.app](https://expired-not.vercel.app)  
**Production Backend:** [https://expirednot.onrender.com](https://expirednot.onrender.com)  
**Document Generated:** September 2026  

---

## 1. Project Overview

### What EXPIREDNOT Does
EXPIREDNOT is an automated pharmacy inventory intelligence and expiry risk mitigation platform. It eliminates manual invoice data entry by utilizing Google Gemini Multimodal Vision AI to digitize physical purchase bills directly into structured batch-level inventory records, and enforces **FEFO (First-Expired, First-Out)** dispensing workflows to prevent medicine expiration losses.

### Problem Solved
1. **Tedious Manual Invoice Data Entry:** Retail pharmacies receive paper purchase bills from multiple pharmaceutical distributors every day. Typing 15–30 medicine names, complex alphanumeric batch numbers, expiry dates, purchase prices, and MRPs into legacy desktop software is time-consuming and prone to human error.
2. **Financial Losses from Expired Stock:** Retail pharmacies in India lose 3% to 7% of annual turnover from medicines expiring unnoticed on back shelves. Distributors offer 100% credit notes only if near-expiry stock is returned within a strict window (typically 60–90 days before expiration).
3. **Patient Safety & Regulatory Violations:** Selling expired or near-expiry drugs violates the Drugs and Cosmetics Act (India) and poses serious health risks to patients.

### Target Users
- Independent retail chemist shops and medical store owners.
- Hospital pharmacy store managers and dispensing staff.
- Pharmaceutical wholesale distributors managing returns and credit notes.

### Main Workflow
1. **Upload Purchase Bill:** The chemist uploads or photographs a distributor invoice (JPG, PNG, or PDF).
2. **Multimodal AI Extraction:** Google Gemini Vision AI parses the invoice, extracting seller, buyer, invoice metadata, and all line items (Batch No, Expiry, Qty, Purchase Rate, MRP).
3. **Side-by-Side Review & Confirmation:** The chemist validates extracted items side-by-side against the original bill preview and confirms.
4. **Automated FEFO Inventory:** Medicines are saved into SQLite database batches, automatically sorted by expiry date.
5. **Real-time Expiry Risk Matrix:** The system highlights at-risk batches (*Critical*, *Warning*, *Near Expiry*) and triggers distributor return manifests before return windows expire.

### What Makes EXPIREDNOT Different
- **True Multimodal AI vs. Legacy OCR:** Uses 2D spatial visual understanding rather than error-prone text-only OCR.
- **Zero Dummy Data Guarantee:** Never falls back to hardcoded fake medicines if extraction fails; instead, prompts user for manual review.
- **Dedicated FEFO Engine:** Natively prioritizes which batch must be dispensed first at point-of-sale.
- **Integrated Distributor Return Manager:** Directly generates credit note claim manifests grouped by distributor.

---

### Pitch & Explanation Formats

#### 30-Second Pitch
> "EXPIREDNOT is an AI-powered pharmacy inventory platform that eliminates manual data entry and prevents expired medicine losses. A chemist simply photographs or uploads a distributor purchase bill; our multimodal AI instantly extracts all medicine names, batch numbers, and expiry dates into a live inventory. The system automatically enforces FEFO dispensing and alerts the chemist well before medicines expire so they can be sold or returned to distributors for full credit notes."

#### 1-Minute Explanation
> "In India, retail pharmacies lose lakhs of rupees every year due to medicines expiring unnoticed on shelves and missed distributor return deadlines. Traditional desktop software requires tedious manual typing of batch numbers and expiry dates, leading to neglected records. EXPIREDNOT solves this by combining Multimodal AI with an automated FEFO inventory engine. Chemists upload supplier invoices as images or PDFs. The backend processes the document through Google Gemini Multimodal AI to extract structured line items without manual typing. These batches enter a live database where our expiry tracking engine calculates real-time shelf life, values at risk, and generates distributor return claims, ensuring zero medicine wastage and 100% regulatory compliance."

#### 3-Minute Technical Explanation
> "From an architectural perspective, EXPIREDNOT is a decoupled, cloud-deployed client-server web application. The frontend is built with high-performance Vanilla JavaScript, CSS3 custom design tokens, and semantic HTML5, hosted globally on Vercel's Edge Network. The backend is a Python 3 service running on Gunicorn WSGI on Render, communicating via RESTful JSON APIs.
> 
> When a chemist uploads an invoice, the frontend transmits the binary file via multipart/form-data to our `/api/bills/analyze` endpoint. The backend saves the raw image locally and feeds the binary buffer to Google Gemini Multimodal AI (`gemini-1.5-flash` / `gemini-2.5-flash` cascade) with a specialized system prompt enforcing strict structured JSON schema extraction and exact-character preservation. Unlike traditional OCR that loses spatial context in complex multi-column invoice tables, multimodal vision AI understands table headers, line items, and financial totals directly in one visual inference pass.
> 
> Once validated on our side-by-side review interface, the data is committed to an SQLite relational database across normalized tables (`bills`, `batches`, `movements`, `notifications`). The backend enforces tenant isolation via PBKDF2-SHA256 authenticated sessions. In the client, dynamic FEFO algorithms compute days-to-expiry and feed real-time SVG visual analytics, P&L statements, and low-stock alerts."

---

## 2. Complete Technology Stack

| Layer | Exact Technology Currently Used | Purpose & Implementation Details |
| :--- | :--- | :--- |
| **Frontend Framework** | **Vanilla JavaScript (ES6+)** | Native DOM manipulation, async/await fetch calls, event delegation. No heavy external frameworks. |
| **Markup** | **Semantic HTML5** | Single-Page Application (SPA) containing 4 primary view containers and 12 workspace panels. |
| **Styling** | **Pure Vanilla CSS3** | Custom design system using CSS Variables (`--color-primary`, `--color-surface`, `--font-brand`), CSS Grid, and Flexbox. |
| **Component Library** | **None (100% Custom)** | Handcrafted responsive components: side-by-side OCR review tables, metric KPI cards, modal dialogs, and navigation drawers. |
| **Routing** | **Custom SPA View Switcher** | CSS class toggles (`.view-active`, `.view-hidden`) governed by `showScreen()` and `switchWorkspaceTab()`. |
| **State Management** | **In-Memory JavaScript State Object** + `localStorage` | Scoped cache (`expirednot_data_<pharmacyId>`) synchronized with backend SQLite via REST APIs. |
| **Form Handling** | **Native HTML5 Form Validation** | Real-time regex validation for emails, phone numbers, Drug License (D.L.) numbers, and auto-advancing 6-digit OTP fields. |
| **Visualizations** | **Native SVG & CSS Data Bars** | Dynamic vector progress rings, bar charts, and metric distribution graphs rendered with pure SVG/CSS. |
| **Icon Library** | **Inline SVG Icons + Unicode Emojis** | Zero external CDN font overhead; instantaneous rendering with zero layout shift. |
| **Backend Language** | **Python 3.13** | Core backend language chosen for rapid I/O, AI SDK support, and data serialization. |
| **Backend Framework** | **Python Standard Library (`http.server`) + WSGI Adapter** | Lightweight, high-concurrency request handling without bulky framework dependencies. |
| **WSGI Server** | **Gunicorn `>=21.2.0`** | Production WSGI HTTP server executing `server:app` on Render. |
| **API Architecture** | **RESTful JSON over HTTP/HTTPS** | Clean JSON endpoints with standard HTTP status codes (200, 201, 400, 401, 403, 404, 429, 500, 502). |
| **Database Engine** | **SQLite3 (`expirednot.db`)** | Embedded ACID-compliant relational database with foreign key support and thread-safe connections. |
| **Database Library** | **Python standard `sqlite3`** with `conn.row_factory = sqlite3.Row` | Direct SQL execution without heavyweight ORM latency. |
| **AI Provider** | **Google Gemini Multimodal REST API** | Invoked via `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`. |
| **AI Model Cascade** | `gemini-1.5-flash`, `gemini-2.5-flash`, `gemini-3.5-flash` | Ultra-fast multimodal inference processing image bytes + system prompt at temperature `0.1`. |
| **OCR Status** | **Multimodal Vision AI (Tesseract is NOT used)** | Raw image bytes sent directly to Gemini Multimodal Vision API, bypassing traditional standalone OCR. |
| **Password Hashing**| **PBKDF2-HMAC-SHA256** | 100,000 iterations + cryptographically secure 16-byte hex salts (`secrets.token_hex(16)`). |
| **OTP Engine** | **SHA-256 Hashed OTPs + 8-byte Salt** | Cryptographically random 6-digit tokens (`secrets.randbelow(900000) + 100000`) with 5-minute expiry and 5-attempt rate limits. |
| **Email Delivery** | **Multi-Provider Dispatch Engine** | 1. **Resend API** (`https://api.resend.com/emails`)<br>2. **Gmail SMTP SSL** (`smtp.gmail.com:465`)<br>3. **Brevo API** (`https://api.brevo.com/v3/smtp/email`)<br>4. Dev console fallback |
| **Google OAuth** | **Google Identity Services OAuth 2.0** | Frontend renders Google Sign-In button; backend verifies ID tokens against `oauth2.googleapis.com/tokeninfo`. |
| **Frontend Host** | **Vercel** (`https://expired-not.vercel.app`) | Global Edge CDN hosting static assets. |
| **Backend Host** | **Render** (`https://expirednot.onrender.com`) | Python 3 Web Service running Gunicorn on port `10000`. |

---

## 3. Project Folder Structure

```text
/Users/vivraj/Desktop/EXPIREDNOT/
├── .env.example             # Template for local environment secrets (Google OAuth, Gemini, Email credentials)
├── .gitignore               # Excludes secrets, databases (*.db), Python caches (__pycache__), and temporary uploads
├── Procfile                 # Process file for Render: "web: gunicorn server:app"
├── README.md                # Project documentation and quickstart instructions
├── requirements.txt         # Production Python dependencies (gunicorn, flask, flask-cors, google-generativeai, python-dotenv)
├── server.py                # Core Python backend: SQLite schema, REST handlers, Gemini AI integration, auth & email engine
├── index.html               # Single Page Application HTML: 4 main views, modal dialogs, and 12 workspace panels
├── styles.css               # Complete design system: CSS variables, flex/grid layouts, active states, and mobile breakpoints
├── app.js                   # Main client controller: session management, API calls, FEFO calculations, DOM rendering
├── assets/                  # Static graphic assets
│   └── pharmacy_shelf_bg.svg# Vector background art for the cinematic welcome screen
└── uploads/                 # Local media storage directory
    └── bills/               # Permanent local repository for uploaded bill images (JPG, PNG, PDF)
```

---

## 4. Frontend View & Panel Breakdown

The application is structured as a Single-Page Application (SPA) inside [index.html](file:///Users/vivraj/Desktop/EXPIREDNOT/index.html) and controlled by [app.js](file:///Users/vivraj/Desktop/EXPIREDNOT/app.js):

### View 1: Welcome Screen (`#welcomeScreen`)
- **What it renders:** Cinematic landing screen with dark pharmacy background, brand wordmark, feature badges, and primary action buttons (*Enter Pharmacy Workspace*, *Live Interactive Demo*).
- **APIs Called:** `/api/config/auth-status` to inspect configured backend capabilities.
- **User Actions:** Clicking *Enter Pharmacy Workspace* checks existing session token. If valid, navigates to Dashboard; otherwise opens Auth Screen.

### View 2: Authentication Screen (`#authScreen`)
- **What it renders:** Split-screen layout with pharmacy intelligence feature showcase on left, and Sign In form (Email/Password, Email OTP, Google OAuth) on right.
- **APIs Called:**
  - `POST /api/auth/login` (email + password)
  - `POST /api/auth/send-login-otp` (passwordless login)
  - `POST /api/auth/google` (Google ID token)
- **User Actions:** Form submission verifies credentials, receives 32-byte session token, saves to `localStorage`, and transitions to Dashboard.

### View 3: Multi-Step Onboarding Wizard (`#signupScreen`)
- **Step 1 (`#paneCreateAccount`):** Email & password input $ightarrow$ Calls `POST /api/auth/register` $ightarrow$ Dispatches 6-digit email OTP.
- **Step 2 (`#paneOtpVerify`):** 6 individual auto-advancing digit inputs $ightarrow$ Calls `POST /api/auth/verify-otp`.
- **Step 3 (`#panePharmacyDetails`):** Pharmacy Name, Drug License (D.L.) Number, GSTIN, and Shop Address.
- **Step 4 (`#paneOwnerDetails`):** Owner Name, Pharmacist Designation, and Mobile Number $ightarrow$ Calls `POST /api/onboarding/complete`.
- **Step 5 (`#paneOnboardingSuccess`):** Completion screen transitioning directly into active workspace.

### View 4: Protected Workspace Shell (`#dashboardScreen`)
Consists of Top Header Bar, Collapsible Vertical Left Sidebar, and 12 Modular Content Panels:

1. **Dashboard Overview (`#paneDashboard`):** 6 KPI metric cards, dynamic risk distribution chart, upcoming expiry table, and supplier return alerts.
2. **Smart Bill Capture (`#paneBills`):** Drag-and-drop zone, camera upload button, extraction progress indicator, and side-by-side invoice review table. Calls `POST /api/bills/analyze` and `POST /api/bills/confirm`.
3. **Medicine Inventory (`#paneInventory`):** Aggregated stock view by medicine name with search filter, expiry filter, total units, and batch count.
4. **Batch Management (`#paneBatches`):** Granular table of every individual batch (`batch_no`, `expiry_date`, `rack`, `purchase_rate`, `mrp`, `quantity`).
5. **Low Stock Alerts (`#paneLowStock`):** Lists medicines where total units are below reorder threshold ($\le 15$ units).
6. **Stock Clearance & Returns (`#paneReturns`):** Actionable table of medicines expiring within 90 days with calculated credit note value and return claim generator.
7. **Sales & Stock Movement (`#paneMovement`):** Audit ledger of all stock additions, sales, clearance, and distributor returns.
8. **Suppliers Directory (`#paneSuppliers`):** Directory of distributors with total purchase volume and outstanding return values.
9. **Pharmacy Expenses (`#paneExpenses`):** Operational overhead logging (Rent, Electricity, Salaries, Licenses).
10. **Analytics & Insights (`#paneAnalytics`):** Financial summary including total inventory value, loss prevented, and turnover rates.
11. **Notifications Feed (`#paneNotifications`):** System notifications and automated expiry warnings.
12. **Pharmacy Settings (`#paneSettings`):** License information, pharmacy address, and account configuration.

---

## 5. Backend REST API Routing Table

| Method | Endpoint | Authentication | Purpose / Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` / `/api/health` | Public | Uptime & health check endpoint for monitoring |
| `GET` | `/api/config/auth-status` | Public | Returns Google Client ID & Gemini configuration status |
| `GET` | `/api/auth/session` | Bearer Token | Verifies active session token and returns user profile |
| `POST` | `/api/auth/register` | Public | Provisional user creation and 6-digit email OTP dispatch |
| `POST` | `/api/auth/verify-otp` | Public | Verifies SHA-256 hashed OTP code and creates session |
| `POST` | `/api/auth/resend-otp` | Public | Resends new OTP (enforcing 30-second rate-limiting cooldown) |
| `POST` | `/api/auth/send-login-otp` | Public | Dispatches login OTP to registered email |
| `POST` | `/api/auth/login` | Public | Verifies email/password via PBKDF2-SHA256 |
| `POST` | `/api/auth/google` | Public | Verifies Google ID token against Google OAuth API |
| `POST` | `/api/onboarding/complete`| Bearer Token | Saves pharmacy details & license numbers |
| `POST` | `/api/auth/logout` | Bearer Token | Invalidate session token in database |
| `POST` | `/api/bills/analyze` | Bearer Token | Uploads bill image, executes Gemini AI extraction |
| `POST` | `/api/bills/confirm` | Bearer Token | Commits verified invoice and batches into database |
| `GET` | `/api/inventory` | Bearer Token | Returns all batches belonging to authenticated pharmacy |
| `GET` | `/api/bills` | Bearer Token | Returns all confirmed purchase invoices |
| `GET` | `/api/analytics` | Bearer Token | Returns aggregated financial and inventory calculations |

---

## 6. Database Architecture & Schema

EXPIREDNOT uses SQLite3 (`expirednot.db`) with 7 relational tables:

```text
+-----------------------------------------------------------------------------------+
|                                   users                                           |
+-----------------------------------------------------------------------------------+
| id (PK, TEXT) | email (TEXT, UNIQUE) | password_hash (TEXT) | salt (TEXT)         |
| email_verified (INT) | setup_completed (INT) | shop_name (TEXT) | dl_number (TEXT)|
| shop_address (TEXT) | city (TEXT) | state (TEXT) | pincode (TEXT)                  |
| pharmacy_type (TEXT) | owner_name (TEXT) | role (TEXT) | auth_provider (TEXT)     |
| created_at (INT)                                                                  |
+-----------------------------------------------------------------------------------+
       | 1                                1 |                                 1 |
       |                                    |                                   |
       | N                                  | N                                 | N
+-------------------+              +-------------------+               +-------------------+
|       bills       |              |      batches      |               |     movements     |
+-------------------+              +-------------------+               +-------------------+
| id (PK, TEXT)     |              | id (PK, TEXT)     |               | id (PK, TEXT)     |
| user_id (FK, TEXT)|              | user_id (FK, TEXT)|               | user_id (FK, TEXT)|
| distributor (TEXT)|              | bill_id (FK, TEXT)|               | type (TEXT)       |
| invoice_no (TEXT) |              | name (TEXT)       |               | medicine_name(TX) |
| invoice_date(TEXT)|              | batch_no (TEXT)   |               | batch_no (TEXT)   |
| total_amount(REAL)|              | expiry_date (TEXT)|               | quantity (REAL)   |
| original_file_path|              | quantity (REAL)   |               | value (REAL)      |
| created_at (INT)  |              | purchase_rate(REA)|               | notes (TEXT)      |
+-------------------+              | mrp (REAL)        |               | created_at (INT)  |
        | 1                        | rack (TEXT)       |               +-------------------+
        |                          | distributor (TEXT)|
        | N                        | created_at (INT)  |
        v                          +-------------------+
+-------------------+
|   (Batch Items)   |
+-------------------+
```

### Additional Supporting Tables:
- **`otps` Table:** `email` (PK, TEXT), `otp_hash` (TEXT), `salt` (TEXT), `expires_at` (INT), `attempts` (INT), `created_at` (INT).
- **`sessions` Table:** `token` (PK, TEXT), `user_id` (FK, TEXT), `expires_at` (INT), `created_at` (INT).
- **`expenses` Table:** `id` (PK, TEXT), `user_id` (FK, TEXT), `category` (TEXT), `description` (TEXT), `amount` (REAL), `date` (TEXT), `created_at` (INT).
- **`notifications` Table:** `id` (PK, TEXT), `user_id` (FK, TEXT), `text` (TEXT), `type` (TEXT), `is_read` (INT), `created_at` (INT).

---

## 7. Smart Bill Capture & Gemini AI Pipeline

```text
[ User selects bill file (PNG, JPG, PDF) ]
                  │
                  ▼
[ Frontend processBillFile() in app.js ]
                  │
                  ▼ (FormData via multipart/form-data)
[ POST /api/bills/analyze on server.py ]
                  │
                  ├───────────────────────────────┐
                  ▼                               ▼
[ Save original file permanently ]     [ Encode image bytes to Base64 ]
  (uploads/bills/BILL_*.jpg)                      │
                                                  ▼
                                       [ Google Gemini Multimodal API ]
                                       (Models: gemini-1.5-flash / 2.5-flash)
                                       (Temperature: 0.1, Response: JSON)
                                                  │
                                                  ▼
                                       [ Structured JSON Payload ]
                                       - Seller & Buyer Metadata
                                       - Invoice No & Date
                                       - Line Items: Name, Batch, Expiry, Qty, Rate, MRP
                                                  │
                                                  ▼
                                       [ normalize_extracted_bill() ]
                                       - Validates required fields
                                       - Zero dummy fallback policy
                                                  │
                                                  ▼
                                       [ Return JSON to Frontend ]
                                                  │
                                                  ▼
                                       [ Side-by-Side Review Screen ]
                                       - Original Bill Preview (Left)
                                       - Editable Extracted Table (Right)
                                                  │
                                                  ▼
                                       [ User clicks "Confirm & Save" ]
                                                  │
                                                  ▼
                                       [ POST /api/bills/confirm ]
                                                  │
                                                  ▼
                                       [ Database Insertion ]
                                       - 1 Record inserted into `bills`
                                       - N Records inserted into `batches`
                                       - N Records logged into `movements`
                                                  │
                                                  ▼
                                       [ Real-Time FEFO Inventory Updated ]
```

---

## 8. FEFO & Expiry Calculation Engine

### Days Remaining Calculation
$$	ext{Days Remaining} = \lfloor rac{	ext{Expiry Date} - 	ext{Current Date}}{86,400,000	ext{ ms}} floor$$

### Risk Categories
1. **Expired ($\le 0$ days):** Red indicator. Immediate loss write-off or distributor return.
2. **Critical Risk ($1 - 30$ days):** Red indicator. Emergency clearance discount or distributor return manifest generation.
3. **Warning ($31 - 90$ days):** Amber indicator. High-priority FEFO front-of-shelf dispensing.
4. **Near Expiry ($91 - 180$ days):** Yellow indicator. Monitored for movement speed.
5. **Healthy ($> 180$ days):** Green indicator. Normal dispensing.

---

## 9. Security & Data Protection

- **Password Security:** PBKDF2-HMAC-SHA256 with 100,000 iterations and per-user 16-byte random salts.
- **OTP Security:** SHA-256 salted hashes; OTPs are never stored in plaintext. Max 5 verification attempts before invalidation.
- **Session Tokens:** 32-byte cryptographically secure random hexadecimal tokens (`secrets.token_hex(32)`) validated against database sessions with 30-day expiration.
- **Multi-Tenant Isolation:** Every private query enforces `WHERE user_id = ?`.
- **CORS Protection:** Enforces origin checks and credential headers for Vercel $\leftrightarrow$ Render communication.

---

## 10. Known Limitations

1. **SQLite Concurrency:** SQLite is embedded. While ideal for single-store deployments, multi-region scaling would benefit from PostgreSQL (e.g. Supabase/Neon).
2. **Render Cold Starts:** Render free tier spins down after 15 minutes of inactivity, resulting in a 30-50 second initial wake-up time.
3. **Printed vs Handwritten Bills:** Optimized specifically for printed B2B pharmaceutical invoices, not handwritten prescriptions.
