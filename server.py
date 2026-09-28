#!/usr/bin/env python3
"""
EXPIREDNOT — Pharmacy Inventory Intelligence Backend Server
"""

import os
import sys
import json
import time
import uuid
import hmac
import hashlib
import secrets
import sqlite3
import threading
import urllib.request
import urllib.parse
import mimetypes
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from email.message import EmailMessage

# Auto-load .env file if present
ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(ENV_PATH):
    try:
        with open(ENV_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except Exception as e:
        print(f"Note: Could not load .env: {e}")

PORT = int(os.environ.get("PORT", 3000))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads", "bills")
DB_PATH = os.path.join(BASE_DIR, "expirednot.db")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
DEMO_OTP_MODE = os.environ.get("DEMO_OTP_MODE", "true").strip().lower() in ("true", "1", "yes")

os.makedirs(UPLOADS_DIR, exist_ok=True)

# ==============================================================================
# DATABASE INITIALIZATION
# ==============================================================================
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        cursor = conn.cursor()
        
        # Users Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE,
                mobile TEXT,
                password_hash TEXT,
                salt TEXT,
                email_verified INTEGER DEFAULT 0,
                setup_completed INTEGER DEFAULT 0,
                shop_name TEXT,
                dl_number TEXT,
                shop_address TEXT,
                city TEXT,
                state TEXT,
                pincode TEXT,
                pharmacy_type TEXT,
                owner_name TEXT,
                role TEXT,
                auth_provider TEXT DEFAULT 'email',
                created_at INTEGER
            )
        ''')
        
        # Ensure extra address and profile columns exist in existing database
        for col, c_type in [('shop_address', 'TEXT'), ('city', 'TEXT'), ('state', 'TEXT'), ('pincode', 'TEXT'), ('profile_photo', 'TEXT')]:
            try:
                cursor.execute(f"ALTER TABLE users ADD COLUMN {col} {c_type}")
            except Exception:
                pass
        
        # OTPs Table (Stores SHA-256 Hashed OTPs only)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS otps (
                email TEXT PRIMARY KEY,
                otp_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                attempts INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL
            )
        ''')
        
        # Sessions Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        ''')
        
        # Bills Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS bills (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                distributor TEXT,
                seller_data TEXT,
                buyer_data TEXT,
                invoice_no TEXT,
                invoice_date TEXT,
                total_amount REAL DEFAULT 0,
                taxes_data TEXT,
                original_file_path TEXT,
                file_name TEXT,
                file_type TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        ''')
        
        # Bill Documents Table (Persistent binary storage for original uploaded bills)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS bill_documents (
                bill_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                file_name TEXT NOT NULL,
                file_mime TEXT NOT NULL,
                file_data BLOB NOT NULL,
                file_size INTEGER NOT NULL,
                file_hash TEXT,
                created_at INTEGER NOT NULL
            )
        ''')
        try:
            cursor.execute("ALTER TABLE bill_documents ADD COLUMN file_hash TEXT")
        except Exception:
            pass
        
        # Batches Table (Real Inventory)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS batches (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                bill_id TEXT,
                name TEXT NOT NULL,
                generic_name TEXT,
                brand TEXT,
                manufacturer TEXT,
                pack TEXT,
                batch_no TEXT NOT NULL,
                mfg_date TEXT,
                expiry_date TEXT NOT NULL,
                quantity REAL NOT NULL,
                purchase_rate REAL NOT NULL,
                mrp REAL,
                rack TEXT,
                distributor TEXT,
                discount REAL DEFAULT 0,
                tax_pct REAL DEFAULT 0,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        ''')
        
        # Stock Movements Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS movements (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                type TEXT NOT NULL,
                medicine_name TEXT NOT NULL,
                batch_no TEXT NOT NULL,
                quantity REAL NOT NULL,
                value REAL NOT NULL,
                notes TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        ''')
        
        # Operating Expenses Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS expenses (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                category TEXT NOT NULL,
                description TEXT NOT NULL,
                amount REAL NOT NULL,
                date TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        ''')
        
        # Real Event Notifications Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                text TEXT NOT NULL,
                type TEXT NOT NULL,
                is_read INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        ''')
        
        # Seed test user if not exists
        cursor.execute("SELECT id FROM users WHERE email = 'rajesh.sharma@medicarechemists.com'")
        if not cursor.fetchone():
            salt = secrets.token_hex(16)
            pwd_hash = hashlib.pbkdf2_hmac('sha256', b'password123', salt.encode(), 100000).hex()
            cursor.execute('''
                INSERT INTO users (id, email, mobile, password_hash, salt, email_verified, setup_completed, shop_name, dl_number, pharmacy_type, owner_name, role, auth_provider, created_at)
                VALUES ('USR_RAJESH_01', 'rajesh.sharma@medicarechemists.com', '9876543210', ?, ?, 1, 1, 'Medicare Chemist & Druggist', 'DL-20B/94812', 'Retail Pharmacy', 'Rajesh Sharma', 'Owner', 'email', ?)
            ''', (pwd_hash, salt, int(time.time())))
        
        conn.commit()

init_db()

# ==============================================================================
# SECURITY & AUTH UTILITIES
# ==============================================================================
def hash_password(password, salt=None):
    if not salt:
        salt = secrets.token_hex(16)
    pwd_hash = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000).hex()
    return pwd_hash, salt

def verify_password(password, pwd_hash, salt):
    if not password or not pwd_hash or not salt:
        return False
    try:
        test_hash = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), str(salt).encode('utf-8'), 100000).hex()
        return hmac.compare_digest(test_hash, str(pwd_hash))
    except Exception as e:
        print(f"[AUTH PASSWORD VERIFY ERROR]: {e}", file=sys.stderr)
        return False

def generate_secure_otp():
    return str(secrets.randbelow(900000) + 100000)

def hash_otp(otp_str, salt=None):
    if not salt:
        salt = secrets.token_hex(8)
    h = hashlib.sha256((otp_str + salt).encode('utf-8')).hexdigest()
    return h, salt

def sanitize_user(user_row):
    if not user_row:
        return None
    d = dict(user_row)
    d.pop('password_hash', None)
    d.pop('salt', None)
    return d

def mask_email(email_str):
    if not email_str or '@' not in email_str:
        return 'your email'
    name, domain = email_str.split('@', 1)
    if len(name) > 2:
        masked = name[0] + '***' + name[-1]
    else:
        masked = name[0] + '***'
    return f"{masked}@{domain}"

def send_email_otp(to_email, otp_code):
    """
    Dispatches 6-digit OTP directly to user's real email address.
    Checks configured providers:
    1. Resend API (RESEND_API_KEY)
    2. Gmail SMTP (GMAIL_USER + GMAIL_APP_PASSWORD)
    3. Brevo API (BREVO_API_KEY)
    Returns: (success: bool, error_message: str)
    """
    resend_key = os.environ.get("RESEND_API_KEY", "").strip()
    from_email = os.environ.get("FROM_EMAIL", os.environ.get("RESEND_FROM", "EXPIREDNOT <onboarding@resend.dev>")).strip()
    
    # 1. Try Resend API if configured
    if resend_key:
        try:
            url = "https://api.resend.com/emails"
            payload = {
                "from": from_email,
                "to": [to_email],
                "subject": f"{otp_code} is your EXPIREDNOT verification code",
                "html": f"""
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
                    <h2 style="color: #059669; margin: 0 0 12px 0;">EXPIREDNOT</h2>
                    <p style="font-size: 15px; color: #334155; line-height: 1.5;">Here is your 6-digit verification code to access your pharmacy workspace:</p>
                    <div style="background: #ecfdf5; border: 1.5px dashed #10b981; border-radius: 8px; padding: 16px; text-align: center; margin: 20px 0;">
                        <span style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #047857; font-family: monospace;">{otp_code}</span>
                    </div>
                    <p style="font-size: 13px; color: #64748b; margin: 0;">Valid for <strong>5 minutes</strong>. Never share this code with anyone.</p>
                </div>
                """
            }
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode('utf-8'),
                headers={'Authorization': f'Bearer {resend_key}', 'Content-Type': 'application/json'}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status in (200, 201):
                    print(f"[RESEND EMAIL SUCCESS] Dispatched OTP to {to_email}", file=sys.stdout)
                    return True, ""
        except urllib.error.HTTPError as e:
            err_body = ""
            try:
                err_body = e.read().decode('utf-8')
            except Exception:
                pass
            print(f"[RESEND EMAIL ERROR]: HTTP {e.code} {e.reason}: {err_body}", file=sys.stderr)
            if e.code == 403 and "onboarding@resend.dev" in from_email:
                print(f"[RESEND POLICY NOTE]: onboarding@resend.dev only permits sending to the Resend account owner. Checking configured fallbacks...", file=sys.stderr)
        except Exception as e:
            print(f"[RESEND EMAIL ERROR]: {e}", file=sys.stderr)

    # 2. Try Gmail SMTP if configured
    gmail_user = os.environ.get("GMAIL_USER", "").strip()
    gmail_pass = os.environ.get("GMAIL_APP_PASSWORD", "").strip()
    if gmail_user and gmail_pass:
        try:
            import smtplib
            from email.mime.text import MIMEText
            from email.mime.multipart import MIMEMultipart

            msg = MIMEMultipart('alternative')
            msg['Subject'] = f"{otp_code} is your EXPIREDNOT verification code"
            msg['From'] = f"EXPIREDNOT <{gmail_user}>"
            msg['To'] = to_email

            html_body = f"""
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
                <h2 style="color: #059669; margin: 0 0 12px 0;">EXPIREDNOT</h2>
                <p style="font-size: 15px; color: #334155; line-height: 1.5;">Here is your 6-digit verification code to access your pharmacy workspace:</p>
                <div style="background: #ecfdf5; border: 1.5px dashed #10b981; border-radius: 8px; padding: 16px; text-align: center; margin: 20px 0;">
                    <span style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #047857; font-family: monospace;">{otp_code}</span>
                </div>
                <p style="font-size: 13px; color: #64748b; margin: 0;">Valid for <strong>5 minutes</strong>. Never share this code with anyone.</p>
            </div>
            """
            msg.attach(MIMEText(html_body, 'html'))

            with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=10) as server:
                server.login(gmail_user, gmail_pass)
                server.sendmail(gmail_user, [to_email], msg.as_string())
            print(f"[GMAIL SMTP SUCCESS] Dispatched OTP to {to_email}", file=sys.stdout)
            return True, ""
        except Exception as e:
            print(f"[GMAIL SMTP ERROR]: {e}", file=sys.stderr)

    # 3. Try Brevo API if configured
    brevo_key = os.environ.get("BREVO_API_KEY", "").strip()
    if brevo_key:
        try:
            b_url = "https://api.brevo.com/v3/smtp/email"
            b_from_email = os.environ.get("BREVO_FROM_EMAIL", os.environ.get("FROM_EMAIL", gmail_user or "onboarding@resend.dev")).strip()
            b_payload = {
                "sender": {"name": "EXPIREDNOT", "email": b_from_email},
                "to": [{"email": to_email}],
                "subject": f"{otp_code} is your EXPIREDNOT verification code",
                "htmlContent": f"""
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
                    <h2 style="color: #059669; margin: 0 0 12px 0;">EXPIREDNOT</h2>
                    <p style="font-size: 15px; color: #334155; line-height: 1.5;">Here is your 6-digit verification code to access your pharmacy workspace:</p>
                    <div style="background: #ecfdf5; border: 1.5px dashed #10b981; border-radius: 8px; padding: 16px; text-align: center; margin: 20px 0;">
                        <span style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #047857; font-family: monospace;">{otp_code}</span>
                    </div>
                    <p style="font-size: 13px; color: #64748b; margin: 0;">Valid for <strong>5 minutes</strong>. Never share this code with anyone.</p>
                </div>
                """
            }
            b_req = urllib.request.Request(
                b_url,
                data=json.dumps(b_payload).encode('utf-8'),
                headers={'api-key': brevo_key, 'Content-Type': 'application/json'}
            )
            with urllib.request.urlopen(b_req, timeout=10) as resp:
                if resp.status in (200, 201):
                    print(f"[BREVO EMAIL SUCCESS] Dispatched OTP to {to_email}", file=sys.stdout)
                    return True, ""
        except Exception as e:
            print(f"[BREVO EMAIL ERROR]: {e}", file=sys.stderr)

    # In local development if no keys are configured, log to stdout
    if not resend_key and not (gmail_user and gmail_pass) and not brevo_key:
        print(f"[DEV CONSOLE OTP] Verification OTP for {to_email}: {otp_code}", file=sys.stdout)
        return True, ""

    return False, "Email provider failed to deliver code. Please verify sender domain in Resend or configure Gmail/Brevo credentials."

# ==============================================================================
# GEMINI MULTIMODAL DOCUMENT AI BILL EXTRACTION SERVICE (SOURCE-OF-TRUTH ENGINE)
# ==============================================================================
def validate_extracted_bill(data):
    """
    Strict non-mutating validation for extracted pharmacy purchase bills.
    Inspects header and line items for missing fields, malformed dates, suspicious numbers,
    and inconsistencies. NEVER synthesizes or guesses fallback values.
    Annotates `needs_verification = True` and records validation issues.
    """
    if not isinstance(data, dict):
        return {"is_valid": False, "issues": ["Invalid bill structure"], "items_flagged": 0}
        
    issues = []
    items = data.get('items', [])
    items_flagged = 0
    
    # Header validations
    distributor = data.get('distributor')
    invoice_no = data.get('invoice_no')
    invoice_date = data.get('invoice_date')
    
    if not distributor or not str(distributor).strip():
        issues.append("Seller/Distributor name could not be identified from bill.")
    if not invoice_no or not str(invoice_no).strip():
        issues.append("Invoice/Bill number could not be identified from bill.")
    if not invoice_date or not str(invoice_date).strip():
        issues.append("Invoice date could not be identified from bill.")
        
    # Item validations
    seen_batches = set()
    current_year = time.gmtime().tm_year
    
    for idx, it in enumerate(items):
        item_issues = []
        name = (it.get('name') or '').strip()
        batch_no = (it.get('batch_no') or '').strip()
        exp = (it.get('expiry_date') or '').strip()
        qty = it.get('quantity')
        rate = it.get('purchase_rate')
        mrp = it.get('mrp')
        
        if not name:
            item_issues.append("Missing medicine name")
            
        if not batch_no:
            item_issues.append("Missing batch number")
            
        if not exp:
            item_issues.append("Missing expiry date")
        else:
            # Check date format and range
            cleaned_exp = exp.replace('/', '-').replace('.', '-')
            parts = cleaned_exp.split('-')
            valid_exp_syntax = False
            
            if len(parts) == 2:
                p1, p2 = parts[0], parts[1]
                if len(p1) == 4 and p1.isdigit() and p2.isdigit(): # YYYY-MM
                    y, m = int(p1), int(p2)
                    if 1 <= m <= 12 and (current_year - 5) <= y <= (current_year + 20):
                        valid_exp_syntax = True
                elif p1.isdigit() and len(p2) in (2, 4) and p2.isdigit(): # MM-YY or MM-YYYY
                    m = int(p1)
                    y = int(p2) if len(p2) == 4 else (2000 + int(p2))
                    if 1 <= m <= 12 and (current_year - 5) <= y <= (current_year + 20):
                        valid_exp_syntax = True
            elif len(parts) == 3: # DD-MM-YYYY or YYYY-MM-DD
                valid_exp_syntax = True
                
            if not valid_exp_syntax:
                item_issues.append(f"Uncertain or malformed expiry date ('{exp}')")
                
        if qty is None or qty <= 0:
            item_issues.append("Quantity missing or invalid")
            
        if rate is None or rate < 0:
            item_issues.append("Purchase rate missing or invalid")
            
        if mrp is not None and rate is not None and mrp < rate:
            item_issues.append(f"MRP (₹{mrp}) is lower than purchase rate (₹{rate})")
            
        if name and batch_no:
            key = (name.upper(), batch_no.upper())
            if key in seen_batches:
                item_issues.append(f"Duplicate line item with same batch ({batch_no})")
            seen_batches.add(key)
            
        if item_issues:
            items_flagged += 1
            it['needs_verification'] = True
            it['conf'] = 'needs_verification'
            it['validation_notes'] = item_issues
        else:
            it['validation_notes'] = []
            
    summary = {
        "is_valid": len(issues) == 0 and items_flagged == 0,
        "header_issues": issues,
        "total_items": len(items),
        "items_flagged": items_flagged
    }
    data['validation_summary'] = summary
    return summary

def normalize_extracted_bill(raw_data):
    """
    Normalizes structured JSON returned by Gemini Multimodal Document AI.
    Strict Source-of-Truth: preserves exact printed characters and nulls.
    NEVER injects fabricated defaults, estimated prices, or synthetic dates.
    """
    if not isinstance(raw_data, dict):
        return None
    
    items_raw = raw_data.get('items') or raw_data.get('line_items') or raw_data.get('products') or raw_data.get('medicines') or []
    if not isinstance(items_raw, list):
        items_raw = []
        
    normalized_items = []
    for it in items_raw:
        if not isinstance(it, dict):
            continue
        name = str(it.get('name') or it.get('product_name') or it.get('item_name') or it.get('description') or '').strip()
        if not name:
            continue
        
        batch_raw = it.get('batch_no') or it.get('batch_number') or it.get('batch')
        batch_no = str(batch_raw).strip().upper() if batch_raw is not None and str(batch_raw).strip().lower() not in ('null', 'none', '') else None
        
        expiry_raw = it.get('expiry_date') or it.get('expiry') or it.get('exp_date') or it.get('exp')
        expiry_date = str(expiry_raw).strip() if expiry_raw is not None and str(expiry_raw).strip().lower() not in ('null', 'none', '') else None
        
        # Parse numeric fields safely without synthetic fallbacks
        quantity = None
        raw_qty = it.get('quantity') if it.get('quantity') is not None else it.get('qty')
        if raw_qty is not None and str(raw_qty).strip().lower() not in ('null', 'none', ''):
            try:
                quantity = float(raw_qty)
            except (ValueError, TypeError):
                quantity = None
                
        free_qty = None
        raw_free = it.get('free_qty') if it.get('free_qty') is not None else (it.get('free_quantity') if it.get('free_quantity') is not None else it.get('free'))
        if raw_free is not None and str(raw_free).strip().lower() not in ('null', 'none', ''):
            try:
                free_qty = float(raw_free)
            except (ValueError, TypeError):
                free_qty = None

        purchase_rate = None
        raw_rate = it.get('purchase_rate') if it.get('purchase_rate') is not None else (it.get('purchase_price') if it.get('purchase_price') is not None else (it.get('rate') if it.get('rate') is not None else it.get('unit_price')))
        if raw_rate is not None and str(raw_rate).strip().lower() not in ('null', 'none', ''):
            try:
                purchase_rate = float(raw_rate)
            except (ValueError, TypeError):
                purchase_rate = None

        mrp = None
        raw_mrp = it.get('mrp') if it.get('mrp') is not None else it.get('max_retail_price')
        if raw_mrp is not None and str(raw_mrp).strip().lower() not in ('null', 'none', ''):
            try:
                mrp = float(raw_mrp)
            except (ValueError, TypeError):
                mrp = None

        tax_pct = None
        raw_tax = it.get('tax_pct') if it.get('tax_pct') is not None else (it.get('tax_percentage') if it.get('tax_percentage') is not None else (it.get('gst') if it.get('gst') is not None else it.get('gst_pct')))
        if raw_tax is not None and str(raw_tax).strip().lower() not in ('null', 'none', ''):
            try:
                tax_pct = float(raw_tax)
            except (ValueError, TypeError):
                tax_pct = None

        discount = None
        raw_disc = it.get('discount') if it.get('discount') is not None else it.get('disc')
        if raw_disc is not None and str(raw_disc).strip().lower() not in ('null', 'none', ''):
            try:
                discount = float(raw_disc)
            except (ValueError, TypeError):
                discount = None

        line_total = None
        raw_lt = it.get('line_total') if it.get('line_total') is not None else it.get('total')
        if raw_lt is not None and str(raw_lt).strip().lower() not in ('null', 'none', ''):
            try:
                line_total = float(raw_lt)
            except (ValueError, TypeError):
                line_total = None
        elif quantity is not None and purchase_rate is not None:
            line_total = round(quantity * purchase_rate, 2)

        conf = str(it.get('conf') or it.get('confidence') or 'high').lower()
        needs_verif = bool(
            it.get('needs_verification') or
            not batch_no or
            not expiry_date or
            quantity is None or
            purchase_rate is None or
            'need' in conf or
            'low' in conf or
            'unverif' in conf
        )
        
        if 'low' in conf or 'need' in conf or not batch_no or not expiry_date or quantity is None or purchase_rate is None:
            conf = 'needs_verification'
        elif 'med' in conf:
            conf = 'medium'
        else:
            conf = 'high'

        pack = str(it.get('pack') or it.get('pack_size') or '').strip() or None

        normalized_items.append({
            "name": name,
            "generic_name": it.get('generic_name') or None,
            "brand": it.get('brand') or None,
            "manufacturer": it.get('manufacturer') or it.get('mfg_by') or None,
            "strength": it.get('strength') or None,
            "dosage_form": it.get('dosage_form') or it.get('form') or None,
            "pack": pack,
            "batch_no": batch_no,
            "mfg_date": it.get('mfg_date') or it.get('manufacturing_date') or None,
            "expiry_date": expiry_date,
            "quantity": quantity,
            "free_qty": free_qty,
            "purchase_rate": purchase_rate,
            "unit_price": purchase_rate,
            "mrp": mrp,
            "discount": discount,
            "tax_pct": tax_pct,
            "line_total": line_total,
            "conf": conf,
            "needs_verification": needs_verif
        })

    if not normalized_items:
        return None

    raw_tot = raw_data.get('total_amount') if raw_data.get('total_amount') is not None else (raw_data.get('grand_total') if raw_data.get('grand_total') is not None else raw_data.get('net_amount'))
    total_amount = None
    if raw_tot is not None and str(raw_tot).strip().lower() not in ('null', 'none', ''):
        try:
            total_amount = float(raw_tot)
        except (ValueError, TypeError):
            total_amount = None
    if total_amount is None:
        valid_line_totals = [i['line_total'] for i in normalized_items if i['line_total'] is not None]
        if valid_line_totals:
            total_amount = round(sum(valid_line_totals), 2)

    seller_dict = raw_data.get('seller') if isinstance(raw_data.get('seller'), dict) else {}
    buyer_dict = raw_data.get('buyer') if isinstance(raw_data.get('buyer'), dict) else {}

    distributor = raw_data.get('distributor') or raw_data.get('seller_name') or seller_dict.get('name') or None
    invoice_no = raw_data.get('invoice_no') or raw_data.get('bill_no') or None
    invoice_date = raw_data.get('invoice_date') or raw_data.get('bill_date') or None

    def _get_float_or_zero(val):
        if val is None or str(val).strip().lower() in ('null', 'none', ''):
            return 0.0
        try:
            return float(val)
        except (ValueError, TypeError):
            return 0.0

    normalized_doc = {
        "success": True,
        "distributor": str(distributor).strip() if distributor else None,
        "seller_address": raw_data.get('seller_address') or seller_dict.get('address') or None,
        "seller_phone": raw_data.get('seller_phone') or seller_dict.get('phone') or None,
        "seller_gstin": raw_data.get('seller_gstin') or seller_dict.get('gstin') or None,
        "seller_dl": raw_data.get('seller_dl') or seller_dict.get('dl_number') or None,
        "buyer_name": raw_data.get('buyer_name') or buyer_dict.get('name') or None,
        "buyer_address": raw_data.get('buyer_address') or buyer_dict.get('address') or None,
        "buyer_phone": raw_data.get('buyer_phone') or buyer_dict.get('phone') or None,
        "buyer_gstin": raw_data.get('buyer_gstin') or buyer_dict.get('gstin') or None,
        "invoice_no": str(invoice_no).strip() if invoice_no else None,
        "invoice_date": str(invoice_date).strip() if invoice_date else None,
        "purchase_date": raw_data.get('purchase_date') or None,
        "due_date": raw_data.get('due_date') or None,
        "payment_terms": raw_data.get('payment_terms') or None,
        "subtotal": _get_float_or_zero(raw_data.get('subtotal')),
        "taxable_amount": _get_float_or_zero(raw_data.get('taxable_amount')),
        "cgst": _get_float_or_zero(raw_data.get('cgst')),
        "sgst": _get_float_or_zero(raw_data.get('sgst')),
        "igst": _get_float_or_zero(raw_data.get('igst')),
        "discount": _get_float_or_zero(raw_data.get('discount')),
        "other_charges": _get_float_or_zero(raw_data.get('other_charges')),
        "total_amount": round(total_amount, 2) if total_amount is not None else None,
        "items": normalized_items
    }
    
    validate_extracted_bill(normalized_doc)
    return normalized_doc

def call_gemini_multimodal_bill_parser(image_bytes, mime_type="image/jpeg"):
    """
    Calls Google Gemini Multimodal REST API with image payload and strict structured JSON schema.
    Returns structured invoice header + item list. NEVER invents or uses fallback dummy data.
    Logs granular performance timings at each step.
    """
    t_start = time.perf_counter()
    print(f"[Bill] request received (size: {len(image_bytes)} bytes, mime: '{mime_type}')", file=sys.stdout)
    
    api_key = (GEMINI_API_KEY or os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "") or "").strip().strip('\"\'')
    
    if not api_key:
        print("[BILL AI ENGINE] Gemini API key not in environment. Reporting not_configured.", file=sys.stderr)
        return {
            "success": False,
            "error": "Smart Bill Capture is not configured yet. Please configure GEMINI_API_KEY in your environment or enter bill details manually.",
            "not_configured": True,
            "items": []
        }
    
    system_instruction = (
        "You are EXPIREDNOT's high-precision pharmacy purchase bill intelligence engine. "
        "The uploaded bill is the SINGLE SOURCE OF TRUTH. "
        "Extract ONLY what is visibly printed on the invoice document. "
        "CRITICAL SOURCE-OF-TRUTH RULES: "
        "1. NEVER invent, hallucinate, autocorrect, expand, or substitute medicine names, strengths, dosages, or batches using external medical knowledge. "
        "2. Preserve exact printed product characters, capitalization, spelling, abbreviations, and punctuation (e.g. if printed 'ABC-650 TAB', output 'ABC-650 TAB', do NOT change to 'Paracetamol'). "
        "3. If a field is missing, unclear, smudged, or not present on the bill, set its value to null. NEVER use fake or estimated defaults. "
        "4. For every line item, extract: name, generic_name (null if not printed), brand (null if not printed), manufacturer (null if not printed), strength, dosage_form, pack, batch_no, mfg_date, expiry_date [format YYYY-MM if readable], quantity, free_qty (bonus/scheme qty, null if not present), purchase_rate, unit_price, mrp (null if not printed), discount, tax_pct, line_total, conf ('high', 'medium', or 'needs_verification'), needs_verification (true/false). "
        "5. Extract SELLER (distributor/name, seller_address, seller_phone, seller_gstin, seller_dl), BUYER (buyer_name, buyer_address, buyer_phone, buyer_gstin), INVOICE (invoice_no, invoice_date, purchase_date, due_date, payment_terms), and TOTALS (subtotal, taxable_amount, cgst, sgst, igst, discount, other_charges, total_amount). "
        "6. Distinct physical medicine or batch rows must remain separate line items. Do not merge separate batches. "
        "Output strictly valid JSON with keys: distributor, seller_address, seller_phone, seller_gstin, seller_dl, buyer_name, buyer_address, buyer_phone, buyer_gstin, invoice_no, invoice_date, purchase_date, due_date, payment_terms, subtotal, taxable_amount, cgst, sgst, igst, discount, other_charges, total_amount, items."
    )
    
    last_error_detail = "All models failed"
    
    try:
        t_prep_0 = time.perf_counter()
        import base64
        import ssl
        b64_data = base64.b64encode(image_bytes).decode('utf-8')
        
        # Build strict verified SSL Context using certifi CA bundle or system CA store
        try:
            import certifi
            ssl_ctx = ssl.create_default_context(cafile=certifi.where())
        except Exception:
            ssl_ctx = ssl.create_default_context()
            
        t_prep_1 = time.perf_counter()
        print(f"[Bill] image preparation completed (time: {t_prep_1 - t_prep_0:.4f}s)", file=sys.stdout)
        
        gemini_models = [
            'gemini-3.8-flash',
            'gemini-3.7-flash',
            'gemini-3.6-flash',
            'gemini-flash-latest',
            'gemini-3.5-flash',
            'gemini-3.5-flash-lite'
        ]
        
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": system_instruction},
                        {
                            "inline_data": {
                                "mime_type": mime_type,
                                "data": b64_data
                            }
                        }
                    ]
                }
            ],
            "generationConfig": {
                "response_mime_type": "application/json",
                "temperature": 0.1,
                "thinkingConfig": {
                    "thinkingLevel": "low"
                }
            }
        }
        
        for model in gemini_models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
            print(f"[Gemini] request started (model: '{model}', mime: '{mime_type}', payload: {len(image_bytes)} bytes)", file=sys.stdout)
            t_req_0 = time.perf_counter()
            try:
                req = urllib.request.Request(
                    url,
                    data=json.dumps(payload).encode('utf-8'),
                    headers={
                        'Content-Type': 'application/json',
                        'x-goog-api-key': api_key
                    }
                )
                with urllib.request.urlopen(req, context=ssl_ctx, timeout=60) as resp:
                    raw_resp = resp.read().decode('utf-8')
                    t_req_1 = time.perf_counter()
                    print(f"[Gemini] response received (model: '{model}', status: {resp.status}, latency: {t_req_1 - t_req_0:.2f}s)", file=sys.stdout)
                    
                    data = json.loads(raw_resp)
                    candidates = data.get('candidates', [])
                    if candidates:
                        parts = candidates[0].get('content', {}).get('parts', [])
                        raw_text = ""
                        for p in parts:
                            if 'text' in p and p['text']:
                                raw_text += p['text']
                        
                        # Strip markdown fences if present
                        cleaned_text = raw_text.strip()
                        if cleaned_text.startswith('```'):
                            lines = cleaned_text.splitlines()
                            if len(lines) >= 2 and lines[0].startswith('```'):
                                lines = lines[1:]
                            if len(lines) >= 1 and lines[-1].strip() == '```':
                                lines = lines[:-1]
                            cleaned_text = '\n'.join(lines).strip()
                        
                        t_json_0 = time.perf_counter()
                        try:
                            raw_json = json.loads(cleaned_text)
                            t_json_1 = time.perf_counter()
                            print(f"[Gemini] JSON parsed (time: {t_json_1 - t_json_0:.4f}s)", file=sys.stdout)
                            
                            t_norm_0 = time.perf_counter()
                            normalized = normalize_extracted_bill(raw_json)
                            t_norm_1 = time.perf_counter()
                            
                            if normalized:
                                val_summary = normalized.get('validation_summary', {})
                                print(f"[Bill] validation completed (issues: {len(val_summary.get('header_issues', [])) + val_summary.get('items_flagged', 0)}, time: {t_norm_1 - t_norm_0:.4f}s)", file=sys.stdout)
                                print(f"[Bill] normalization completed (items: {len(normalized['items'])}, time: {t_norm_1 - t_norm_0:.4f}s)", file=sys.stdout)
                                print(f"[Bill] total processing time: {time.perf_counter() - t_start:.2f}s", file=sys.stdout)
                                return normalized
                            else:
                                print(f"[GEMINI BILL AI WARN] Model '{model}' returned empty items list: {cleaned_text[:200]}", file=sys.stderr)
                        except json.JSONDecodeError as jde:
                            print(f"[GEMINI BILL AI ERROR] JSON parsing failed for model '{model}': {jde} | text: {cleaned_text[:200]}", file=sys.stderr)
            except urllib.error.HTTPError as he:
                err_body = ""
                try:
                    err_body = he.read().decode('utf-8')
                    err_json = json.loads(err_body)
                    err_msg = err_json.get('error', {}).get('message', err_body)
                except Exception:
                    err_msg = str(he)
                
                cat = "HTTP Error"
                if he.code == 401:
                    cat = "401 Authentication / Invalid API Key"
                elif he.code == 403:
                    cat = "403 Forbidden / Key Restricted or IP Blocked"
                elif he.code == 404:
                    cat = "404 Model Not Found / Unsupported Endpoint"
                elif he.code == 400:
                    cat = "400 Malformed Request Payload"
                elif he.code == 429:
                    cat = "429 Quota / Rate Limit Exceeded"
                elif he.code in (500, 503):
                    cat = f"{he.code} Google Service Unavailable"
                
                print(f"[GEMINI BILL AI ERROR] Model '{model}' failed -> {cat}: {err_msg}", file=sys.stderr)
                last_error_detail = f"{cat}: {err_msg}"
                continue
            except Exception as e:
                print(f"[GEMINI BILL AI ERROR] Model '{model}' failed -> Exception ({type(e).__name__}): {e}", file=sys.stderr)
                last_error_detail = f"{type(e).__name__}: {e}"
                continue

    except Exception as e:
        print(f"[GEMINI BILL AI CRITICAL ERROR]: {e}", file=sys.stderr)
        return {
            "success": False,
            "error": "Unable to confidently extract this bill. Please review and enter details manually.",
            "diagnostic_info": str(e),
            "items": []
        }

    return {
        "success": False,
        "error": "Unable to confidently extract this bill. Some information could not be read clearly.",
        "diagnostic_info": last_error_detail,
        "items": []
    }

# ==============================================================================
# HTTP REQUEST HANDLER
# ==============================================================================
class ExpiredNotHandler(BaseHTTPRequestHandler):
    
    def _set_cors_headers(self):
        origin = self.headers.get('Origin') or self.headers.get('origin')
        allowed_origins_env = os.environ.get("ALLOWED_ORIGINS", "") or os.environ.get("FRONTEND_URL", "")
        
        if allowed_origins_env and allowed_origins_env.strip() != '*':
            allowed_list = [o.strip().rstrip('/') for o in allowed_origins_env.split(',') if o.strip()]
            if origin and (origin.rstrip('/') in allowed_list or '*' in allowed_list):
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Access-Control-Allow-Credentials', 'true')
            else:
                self.send_header('Access-Control-Allow-Origin', allowed_list[0] if allowed_list else (origin or '*'))
                self.send_header('Access-Control-Allow-Credentials', 'true')
        else:
            if origin:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Access-Control-Allow-Credentials', 'true')
            else:
                self.send_header('Access-Control-Allow-Origin', '*')
                
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Cookie, Accept, Origin')
        self.send_header('Access-Control-Max-Age', '86400')

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self._set_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _get_auth_user(self):
        auth_header = self.headers.get('Authorization', '')
        token = None
        if auth_header.startswith('Bearer '):
            token = auth_header[7:].strip()
        
        if not token:
            cookie = self.headers.get('Cookie', '')
            if 'exp_session=' in cookie:
                token = cookie.split('exp_session=')[1].split(';')[0].strip()

        if not token:
            try:
                url_parsed = urllib.parse.urlparse(self.path)
                q_params = urllib.parse.parse_qs(url_parsed.query)
                if 'token' in q_params and q_params['token']:
                    token = q_params['token'][0].strip()
                elif 'auth_token' in q_params and q_params['auth_token']:
                    token = q_params['auth_token'][0].strip()
            except Exception:
                pass
                
        if not token:
            return None
            
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('''
                SELECT u.* FROM sessions s
                JOIN users u ON s.user_id = u.id
                WHERE s.token = ? AND s.expires_at > ?
            ''', (token, int(time.time())))
            row = cursor.fetchone()
            if row:
                return dict(row)
        return None

    def do_OPTIONS(self):
        self.send_response(204)
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self):
        url_parsed = urllib.parse.urlparse(self.path)
        path = url_parsed.path
        
        if path in ('/health', '/api/health'):
            return self._send_json({
                "status": "ok",
                "service": "EXPIREDNOT",
                "version": "1.0.0",
                "timestamp": int(time.time()),
                "database": "connected"
            })

        elif path in ('/api/config/auth', '/api/config/auth-status'):
            g_client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
            return self._send_json({
                "google_client_id": g_client_id,
                "google_configured": bool(g_client_id and "example" not in g_client_id),
                "gemini_configured": bool(GEMINI_API_KEY or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")),
                "demo_otp_mode": DEMO_OTP_MODE
            })

        elif path == '/api/auth/session':
            user = self._get_auth_user()
            if user:
                return self._send_json({"authenticated": True, "user": sanitize_user(user)})
            return self._send_json({"authenticated": False}, 401)
            
        elif path == '/api/inventory':
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized"}, 401)
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM batches WHERE user_id = ? AND quantity > 0 ORDER BY expiry_date ASC", (user['id'],))
                batches = [dict(r) for r in cursor.fetchall()]
            return self._send_json({"batches": batches})
            
        elif path == '/api/bills':
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized"}, 401)
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM bills WHERE user_id = ? ORDER BY created_at DESC", (user['id'],))
                raw_bills = [dict(r) for r in cursor.fetchall()]
                
                cursor.execute("SELECT * FROM batches WHERE user_id = ? ORDER BY rowid ASC", (user['id'],))
                all_batches = [dict(r) for r in cursor.fetchall()]
                
                batches_by_bill = {}
                for b in all_batches:
                    b_id = b.get('bill_id')
                    if b_id:
                        batches_by_bill.setdefault(b_id, []).append(b)
                
                bills = []
                for rb in raw_bills:
                    b_id = rb['id']
                    seller_parsed = None
                    if rb.get('seller_data'):
                        try:
                            seller_parsed = json.loads(rb['seller_data']) if isinstance(rb['seller_data'], str) else rb['seller_data']
                        except Exception:
                            seller_parsed = rb['seller_data']
                    
                    buyer_parsed = None
                    if rb.get('buyer_data'):
                        try:
                            buyer_parsed = json.loads(rb['buyer_data']) if isinstance(rb['buyer_data'], str) else rb['buyer_data']
                        except Exception:
                            buyer_parsed = rb['buyer_data']

                    taxes_parsed = None
                    if rb.get('taxes_data'):
                        try:
                            taxes_parsed = json.loads(rb['taxes_data']) if isinstance(rb['taxes_data'], str) else rb['taxes_data']
                        except Exception:
                            taxes_parsed = rb['taxes_data']

                    b_items = batches_by_bill.get(b_id, [])
                    bills.append({
                        **rb,
                        "seller_data": seller_parsed,
                        "buyer_data": buyer_parsed,
                        "taxes_data": taxes_parsed,
                        "items_count": len(b_items) if b_items else 1,
                        "items": b_items
                    })
            return self._send_json({"bills": bills})

        elif path.startswith('/api/bills/') and (path.endswith('/document') or path.endswith('/file')):
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized session."}, 401)
            
            parts = path.strip('/').split('/')
            target_bill_id = parts[2] if len(parts) >= 3 else ''
            if not target_bill_id:
                return self._send_json({"error": "Invalid bill document ID."}, 400)

            q_params = urllib.parse.parse_qs(url_parsed.query)
            is_download = q_params.get('download', ['0'])[0] in ('1', 'true', 'yes')

            file_data = None
            file_mime = 'application/octet-stream'
            file_name = f"{target_bill_id}.jpg"

            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute('''
                    SELECT * FROM bill_documents 
                    WHERE bill_id = ? AND (user_id = ? OR user_id = 'PENDING' OR user_id = 'GUEST')
                ''', (target_bill_id, user['id']))
                doc_row = cursor.fetchone()

                if doc_row:
                    file_data = doc_row['file_data']
                    file_mime = doc_row['file_mime'] or 'image/jpeg'
                    file_name = doc_row['file_name'] or f"{target_bill_id}.jpg"
                else:
                    cursor.execute("SELECT * FROM bills WHERE id = ? AND user_id = ?", (target_bill_id, user['id']))
                    bill_row = cursor.fetchone()
                    if not bill_row:
                        return self._send_json({"error": "Bill document not found or access denied."}, 404)
                    
                    disk_files = [f for f in os.listdir(UPLOADS_DIR) if f.startswith(target_bill_id)] if os.path.exists(UPLOADS_DIR) else []
                    if disk_files:
                        disk_path = os.path.join(UPLOADS_DIR, disk_files[0])
                        with open(disk_path, 'rb') as f:
                            file_data = f.read()
                        file_name = bill_row['file_name'] or disk_files[0]
                        file_mime, _ = mimetypes.guess_type(disk_path)
                        if not file_mime:
                            file_mime = 'image/jpeg'

            if not file_data:
                return self._send_json({"error": "Original bill document file is not available."}, 404)

            disposition_type = 'attachment' if is_download else 'inline'
            safe_filename = urllib.parse.quote(file_name)

            self.send_response(200)
            self.send_header('Content-Type', file_mime)
            self.send_header('Content-Length', str(len(file_data)))
            self.send_header('Content-Disposition', f'{disposition_type}; filename="{file_name}"; filename*=UTF-8\'\'{safe_filename}')
            self.send_header('Cache-Control', 'private, max-age=86400')
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(file_data)
            return

        elif path.startswith('/uploads/bills/'):
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized session."}, 401)
            
            req_filename = path.split('/uploads/bills/', 1)[1].strip()
            bill_prefix = os.path.splitext(req_filename)[0]

            file_data = None
            file_mime = 'image/jpeg'
            file_name = req_filename

            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute('''
                    SELECT * FROM bill_documents 
                    WHERE (bill_id = ? OR file_name = ?) AND (user_id = ? OR user_id = 'PENDING' OR user_id = 'GUEST')
                ''', (bill_prefix, req_filename, user['id']))
                doc_row = cursor.fetchone()

                if doc_row:
                    file_data = doc_row['file_data']
                    file_mime = doc_row['file_mime'] or 'image/jpeg'
                    file_name = doc_row['file_name'] or req_filename
                else:
                    disk_path = os.path.join(UPLOADS_DIR, req_filename)
                    if os.path.isfile(disk_path):
                        cursor.execute("SELECT * FROM bills WHERE user_id = ? AND (original_file_path LIKE ? OR file_name = ?)", (user['id'], f"%{req_filename}%", req_filename))
                        if not cursor.fetchone():
                            return self._send_json({"error": "Access denied."}, 403)
                        with open(disk_path, 'rb') as f:
                            file_data = f.read()
                        file_mime, _ = mimetypes.guess_type(disk_path)
                        file_mime = file_mime or 'image/jpeg'

            if not file_data:
                return self._send_json({"error": "File not found or access denied."}, 404)

            self.send_response(200)
            self.send_header('Content-Type', file_mime)
            self.send_header('Content-Length', str(len(file_data)))
            self.send_header('Content-Disposition', f'inline; filename="{file_name}"')
            self.send_header('Cache-Control', 'private, max-age=86400')
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(file_data)
            return

        elif path.startswith('/api/bills/') and len(path) > len('/api/bills/'):
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized"}, 401)
            target_bill_id = path.split('/api/bills/', 1)[1].strip()
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM bills WHERE id = ? AND user_id = ?", (target_bill_id, user['id']))
                row = cursor.fetchone()
                if not row:
                    return self._send_json({"error": "Bill not found."}, 404)
                
                rb = dict(row)
                seller_parsed = None
                if rb.get('seller_data'):
                    try:
                        seller_parsed = json.loads(rb['seller_data']) if isinstance(rb['seller_data'], str) else rb['seller_data']
                    except Exception:
                        seller_parsed = rb['seller_data']
                
                buyer_parsed = None
                if rb.get('buyer_data'):
                    try:
                        buyer_parsed = json.loads(rb['buyer_data']) if isinstance(rb['buyer_data'], str) else rb['buyer_data']
                    except Exception:
                        buyer_parsed = rb['buyer_data']

                taxes_parsed = None
                if rb.get('taxes_data'):
                    try:
                        taxes_parsed = json.loads(rb['taxes_data']) if isinstance(rb['taxes_data'], str) else rb['taxes_data']
                    except Exception:
                        taxes_parsed = rb['taxes_data']

                cursor.execute("SELECT * FROM batches WHERE bill_id = ? AND user_id = ? ORDER BY rowid ASC", (target_bill_id, user['id']))
                items = [dict(r) for r in cursor.fetchall()]
                
                bill_data = {
                    **rb,
                    "seller_data": seller_parsed,
                    "buyer_data": buyer_parsed,
                    "taxes_data": taxes_parsed,
                    "items_count": len(items),
                    "items": items
                }
            return self._send_json({"bill": bill_data})

        elif path == '/api/notifications':
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized"}, 401)
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC", (user['id'],))
                notifs = [dict(r) for r in cursor.fetchall()]
            return self._send_json({"notifications": notifs})

        elif path == '/api/movements':
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized"}, 401)
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM movements WHERE user_id = ? ORDER BY created_at DESC, rowid DESC", (user['id'],))
                movements = [dict(r) for r in cursor.fetchall()]
            return self._send_json({"movements": movements})

        elif path == '/api/profile':
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized"}, 401)
            return self._send_json({"user": sanitize_user(user)})

        elif path == '/api/search':
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized session."}, 401)
            
            q_params = urllib.parse.parse_qs(url_parsed.query)
            q = q_params.get('q', [''])[0].strip()
            if not q or len(q) < 1:
                return self._send_json({"medicines": [], "bills": [], "query": ""})
            
            search_pattern = f"%{q}%"
            with get_db() as conn:
                cursor = conn.cursor()
                
                # 1. Search Batches / Medicines
                cursor.execute('''
                    SELECT id, bill_id, name, generic_name, brand, manufacturer, pack,
                           batch_no, mfg_date, expiry_date, quantity, purchase_rate, mrp,
                           rack, distributor, created_at
                    FROM batches
                    WHERE user_id = ? AND (
                        name LIKE ? OR 
                        generic_name LIKE ? OR 
                        brand LIKE ? OR 
                        manufacturer LIKE ? OR 
                        batch_no LIKE ? OR 
                        distributor LIKE ? OR
                        rack LIKE ?
                    )
                    ORDER BY quantity DESC, expiry_date ASC
                    LIMIT 25
                ''', (user['id'], search_pattern, search_pattern, search_pattern, search_pattern, search_pattern, search_pattern, search_pattern))
                batches = [dict(r) for r in cursor.fetchall()]
                
                # 2. Search Bills
                cursor.execute('''
                    SELECT id, distributor, seller_data, invoice_no, invoice_date, total_amount, original_file_path, file_name, file_type, created_at
                    FROM bills
                    WHERE user_id = ? AND (
                        distributor LIKE ? OR 
                        seller_data LIKE ? OR 
                        invoice_no LIKE ? OR 
                        invoice_date LIKE ?
                    )
                    ORDER BY created_at DESC
                    LIMIT 15
                ''', (user['id'], search_pattern, search_pattern, search_pattern, search_pattern))
                raw_bills = [dict(r) for r in cursor.fetchall()]
                bills = []
                for rb in raw_bills:
                    s_data = None
                    if rb.get('seller_data'):
                        try:
                            s_data = json.loads(rb['seller_data']) if isinstance(rb['seller_data'], str) else rb['seller_data']
                        except Exception:
                            s_data = rb['seller_data']
                    bills.append({**rb, "seller_data": s_data})

            return self._send_json({"medicines": batches, "bills": bills, "query": q})

        elif path == '/api/analytics':
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized"}, 401)
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM batches WHERE user_id = ? AND quantity > 0", (user['id'],))
                batches = [dict(r) for r in cursor.fetchall()]
                cursor.execute("SELECT * FROM movements WHERE user_id = ?", (user['id'],))
                movements = [dict(r) for r in cursor.fetchall()]
                cursor.execute("SELECT * FROM bills WHERE user_id = ?", (user['id'],))
                bills = [dict(r) for r in cursor.fetchall()]
                
            total_stock_value = sum(b['quantity'] * b['purchase_rate'] for b in batches)
            loss_prevented = sum(m['value'] for m in movements if m['type'] in ('Returned', 'Cleared'))
            
            return self._send_json({
                "total_stock_value": total_stock_value,
                "loss_prevented": loss_prevented,
                "active_medicines_count": len(set(b['name'].lower() for b in batches)),
                "active_batches_count": len(batches),
                "total_bills_count": len(bills)
            })

        if path == '/' or path == '/index.html':
            file_path = os.path.join(BASE_DIR, 'index.html')
        else:
            clean_path = path.lstrip('/')
            file_path = os.path.join(BASE_DIR, clean_path)

        if os.path.isfile(file_path):
            mime_type, _ = mimetypes.guess_type(file_path)
            if not mime_type:
                mime_type = 'application/octet-stream'
            with open(file_path, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', mime_type)
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        else:
            index_path = os.path.join(BASE_DIR, 'index.html')
            with open(index_path, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)

    def do_POST(self):
        url_parsed = urllib.parse.urlparse(self.path)
        path = url_parsed.path
        
        try:
            cl_val = self.headers.get('Content-Length', 0)
            content_length = int(cl_val) if cl_val else 0
        except (ValueError, TypeError):
            content_length = 0
            
        post_body = self.rfile.read(content_length) if content_length > 0 else b''
        content_type = self.headers.get('Content-Type', '')
        
        if path == '/api/bills/analyze' and 'multipart/form-data' in content_type:
            user = self._get_auth_user()
            user_id = user['id'] if user else 'GUEST'
            
            try:
                # Robust boundary extraction
                boundary = None
                for param in content_type.split(';'):
                    param = param.strip()
                    if param.startswith('boundary='):
                        boundary = param.split('boundary=', 1)[1].strip('"\'')
                        break
                
                if not boundary:
                    return self._send_json({"error": "Invalid multipart form boundary."}, 400)
                
                boundary_bytes = boundary.encode('utf-8')
                parts = post_body.split(b'--' + boundary_bytes)
                file_bytes = b''
                file_name = 'uploaded_bill.jpg'
                file_mime = 'image/jpeg'
                
                for p in parts:
                    if b'Content-Disposition' in p and b'filename=' in p:
                        header_and_body = p.split(b'\r\n\r\n', 1)
                        if len(header_and_body) == 2:
                            header_raw, body_raw = header_and_body
                            if body_raw.endswith(b'\r\n'):
                                body_raw = body_raw[:-2]
                            file_bytes = body_raw
                            
                            header_str = header_raw.decode('latin1', errors='ignore')
                            for h_line in header_str.split('\r\n'):
                                if 'Content-Type:' in h_line:
                                    file_mime = h_line.split('Content-Type:', 1)[1].strip()
                                if 'filename=' in h_line:
                                    fn_part = h_line.split('filename=', 1)[1].strip()
                                    file_name = fn_part.strip('"\'')
                        break
                
                if not file_bytes:
                    return self._send_json({"error": "No bill file uploaded. Please select an image or PDF."}, 400)
                
                # Determine file extension safely
                ext = os.path.splitext(file_name)[1].lower()
                if not ext or len(ext) < 2:
                    ext = mimetypes.guess_extension(file_mime) or '.jpg'
                if ext in ('.jpeg', '.jpg'):
                    file_mime = 'image/jpeg'
                elif ext == '.png':
                    file_mime = 'image/png'
                elif ext == '.pdf':
                    file_mime = 'application/pdf'
                elif ext == '.webp':
                    file_mime = 'image/webp'
                
                # Calculate secure SHA-256 file hash for Level 1 duplicate detection
                file_hash = hashlib.sha256(file_bytes).hexdigest()

                # LEVEL 1 DUPLICATE CHECK: Exact file hash already confirmed for this user
                if user:
                    with get_db() as conn:
                        cursor = conn.cursor()
                        cursor.execute('''
                            SELECT b.id, b.distributor, b.seller_data, b.invoice_no, b.invoice_date, b.total_amount, b.created_at
                            FROM bill_documents bd
                            JOIN bills b ON bd.bill_id = b.id
                            WHERE bd.user_id = ? AND bd.file_hash = ?
                        ''', (user['id'], file_hash))
                        exact_match = cursor.fetchone()
                        if exact_match:
                            s_obj = None
                            if exact_match['seller_data']:
                                try:
                                    s_obj = json.loads(exact_match['seller_data']) if isinstance(exact_match['seller_data'], str) else exact_match['seller_data']
                                except Exception:
                                    s_obj = None
                            return self._send_json({
                                "success": False,
                                "is_exact_duplicate": True,
                                "duplicate_type": "file_hash",
                                "error": "Bill Already Uploaded: This exact bill has already been added to your Bill History.",
                                "existing_bill": {
                                    "id": exact_match['id'],
                                    "distributor": exact_match['distributor'],
                                    "seller_data": s_obj,
                                    "invoice_no": exact_match['invoice_no'],
                                    "invoice_date": exact_match['invoice_date'],
                                    "total_amount": exact_match['total_amount'],
                                    "created_at": exact_match['created_at']
                                }
                            }, 409)

                # Save original file permanently in uploads/bills/ and SQLite bill_documents
                bill_id = f"BILL_{uuid.uuid4().hex}"
                saved_filename = f"{bill_id}{ext}"
                saved_path = os.path.join(UPLOADS_DIR, saved_filename)
                
                with open(saved_path, 'wb') as sf:
                    sf.write(file_bytes)

                with get_db() as conn:
                    cursor = conn.cursor()
                    cursor.execute('''
                        INSERT OR REPLACE INTO bill_documents (bill_id, user_id, file_name, file_mime, file_data, file_size, file_hash, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (bill_id, user['id'] if user else 'PENDING', file_name, file_mime, file_bytes, len(file_bytes), file_hash, int(time.time())))
                    conn.commit()
                
                relative_file_url = f"/api/bills/{bill_id}/document"
                print(f"[BILL UPLOAD] Stored invoice: bill_id='{bill_id}', filename='{file_name}', hash='{file_hash[:12]}...', size={len(file_bytes)} bytes")
                
                # Analyze via Gemini Multimodal Document AI
                extracted_data = call_gemini_multimodal_bill_parser(file_bytes, file_mime)
                extracted_data["bill_id"] = bill_id
                extracted_data["original_file_url"] = relative_file_url
                extracted_data["file_name"] = file_name
                extracted_data["file_type"] = ext.lstrip('.').lower()
                extracted_data["file_hash"] = file_hash

                # LEVEL 2 DUPLICATE CHECK: Metadata similarity (Supplier + Invoice Number)
                if user and extracted_data.get('invoice_no') and extracted_data.get('distributor'):
                    inv_clean = str(extracted_data.get('invoice_no', '')).strip().upper()
                    dist_clean = str(extracted_data.get('distributor', '')).strip().upper()
                    if inv_clean and dist_clean and inv_clean != 'UNSPECIFIED' and dist_clean != 'UNKNOWN SUPPLIER':
                        with get_db() as conn:
                            cursor = conn.cursor()
                            cursor.execute('''
                                SELECT id, distributor, seller_data, invoice_no, invoice_date, total_amount, created_at
                                FROM bills
                                WHERE user_id = ? AND UPPER(TRIM(invoice_no)) = ? AND UPPER(TRIM(distributor)) = ?
                            ''', (user['id'], inv_clean, dist_clean))
                            meta_match = cursor.fetchone()
                            if meta_match:
                                s_obj = None
                                if meta_match['seller_data']:
                                    try:
                                        s_obj = json.loads(meta_match['seller_data']) if isinstance(meta_match['seller_data'], str) else meta_match['seller_data']
                                    except Exception:
                                        s_obj = None
                                extracted_data["possible_duplicate"] = True
                                extracted_data["duplicate_type"] = "metadata"
                                extracted_data["existing_bill"] = {
                                    "id": meta_match['id'],
                                    "distributor": meta_match['distributor'],
                                    "seller_data": s_obj,
                                    "invoice_no": meta_match['invoice_no'],
                                    "invoice_date": meta_match['invoice_date'],
                                    "total_amount": meta_match['total_amount'],
                                    "created_at": meta_match['created_at']
                                }
                
                return self._send_json(extracted_data)
                
            except Exception as e:
                print(f"Upload Error: {e}", file=sys.stderr)
                return self._send_json({"error": f"Failed to process bill file: {str(e)}"}, 500)

        try:
            req_data = json.loads(post_body.decode('utf-8')) if post_body else {}
        except Exception:
            req_data = {}

        if path == '/api/auth/register':
            email = req_data.get('email', '').strip().lower()
            password = req_data.get('password', '')
            
            if not email or '@' not in email:
                return self._send_json({"error": "Please enter a valid email address."}, 400)
            if len(password) < 8:
                return self._send_json({"error": "Password must be at least 8 characters."}, 400)
                
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT id, setup_completed FROM users WHERE email = ?", (email,))
                existing = cursor.fetchone()
                if existing and existing['setup_completed']:
                    return self._send_json({"error": "An account with this email already exists. Please sign in."}, 400)
                
                otp_code = generate_secure_otp()
                otp_h, otp_salt = hash_otp(otp_code)
                now = int(time.time())
                expires_at = now + (10 * 60) if DEMO_OTP_MODE else now + (5 * 60)
                
                # Only attempt external email delivery if NOT in DEMO_OTP_MODE
                if not DEMO_OTP_MODE:
                    sent_ok, err_reason = send_email_otp(email, otp_code)
                    if not sent_ok:
                        return self._send_json({
                            "error": "We couldn't send the verification email. Please try again.",
                            "details": err_reason,
                            "email_delivery_failed": True
                        }, 502)
                
                cursor.execute('''
                    INSERT OR REPLACE INTO otps (email, otp_hash, salt, expires_at, attempts, created_at)
                    VALUES (?, ?, ?, ?, 0, ?)
                ''', (email, otp_h, otp_salt, expires_at, now))
                
                if not existing:
                    user_id = f"USR_{int(time.time())}_{secrets.token_hex(4)}"
                    pwd_h, pwd_salt = hash_password(password)
                    cursor.execute('''
                        INSERT INTO users (id, email, password_hash, salt, email_verified, setup_completed, created_at)
                        VALUES (?, ?, ?, ?, 0, 0, ?)
                    ''', (user_id, email, pwd_h, pwd_salt, now))
                else:
                    pwd_h, pwd_salt = hash_password(password)
                    cursor.execute("UPDATE users SET password_hash = ?, salt = ? WHERE email = ?", (pwd_h, pwd_salt, email))
                
                conn.commit()
            
            print(f"[SECURITY OTP REGISTER] OTP generated for {email}: {'[DEMO: ' + otp_code + ']' if DEMO_OTP_MODE else '[SENT BY EMAIL]'}", file=sys.stdout)
            
            resp_data = {
                "success": True,
                "message": "Demo verification code generated." if DEMO_OTP_MODE else "Verification code sent to your email.",
                "masked_email": mask_email(email),
                "expires_in_seconds": 600 if DEMO_OTP_MODE else 300,
                "demo_mode": DEMO_OTP_MODE
            }
            if DEMO_OTP_MODE:
                resp_data["demo_otp"] = otp_code
                
            return self._send_json(resp_data)

        elif path == '/api/auth/verify-otp':
            email = req_data.get('email', '').strip().lower()
            code = req_data.get('code', '').strip()
            
            if not email or len(code) != 6:
                return self._send_json({"error": "Please enter the complete 6-digit verification code."}, 400)
                
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM otps WHERE email = ?", (email,))
                otp_record = cursor.fetchone()
                
                if not otp_record:
                    return self._send_json({"error": "No active verification code found. Please request a new code."}, 400)
                    
                now = int(time.time())
                if now > otp_record['expires_at']:
                    return self._send_json({"error": "This verification code has expired. Generate a new code."}, 400)
                    
                if otp_record['attempts'] >= 5:
                    return self._send_json({"error": "Too many failed attempts. Please request a new verification code."}, 429)
                    
                expected_hash, _ = hash_otp(code, otp_record['salt'])
                if not hmac.compare_digest(expected_hash, otp_record['otp_hash']):
                    cursor.execute("UPDATE otps SET attempts = attempts + 1 WHERE email = ?", (email,))
                    conn.commit()
                    return self._send_json({"error": "Incorrect verification code. Please try again."}, 400)
                    
                cursor.execute("UPDATE users SET email_verified = 1 WHERE email = ?", (email,))
                cursor.execute("DELETE FROM otps WHERE email = ?", (email,))
                
                cursor.execute("SELECT * FROM users WHERE email = ?", (email,))
                user = cursor.fetchone()
                
                session_token = secrets.token_hex(32)
                cursor.execute('''
                    INSERT INTO sessions (token, user_id, expires_at, created_at)
                    VALUES (?, ?, ?, ?)
                ''', (session_token, user['id'], now + (30 * 86400), now))
                
                conn.commit()
                
            return self._send_json({
                "success": True,
                "message": "Email verified ✓",
                "session_token": session_token,
                "user": sanitize_user(user)
            })

        elif path == '/api/auth/resend-otp':
            email = req_data.get('email', '').strip().lower()
            if not email:
                return self._send_json({"error": "Email is required."}, 400)
                
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM otps WHERE email = ?", (email,))
                existing_otp = cursor.fetchone()
                now = int(time.time())
                
                if not DEMO_OTP_MODE and existing_otp and (now - existing_otp['created_at']) < 30:
                    wait_time = 30 - (now - existing_otp['created_at'])
                    return self._send_json({"error": f"Please wait {wait_time}s before requesting a new code."}, 429)
                    
                new_otp = generate_secure_otp()
                new_h, new_salt = hash_otp(new_otp)
                expires_at = now + (10 * 60) if DEMO_OTP_MODE else now + (5 * 60)
                
                if not DEMO_OTP_MODE:
                    sent_ok, err_reason = send_email_otp(email, new_otp)
                    if not sent_ok:
                        return self._send_json({
                            "error": "We couldn't send the verification email. Please try again.",
                            "details": err_reason,
                            "email_delivery_failed": True
                        }, 502)
                
                cursor.execute('''
                    INSERT OR REPLACE INTO otps (email, otp_hash, salt, expires_at, attempts, created_at)
                    VALUES (?, ?, ?, ?, 0, ?)
                ''', (email, new_h, new_salt, expires_at, now))
                conn.commit()
                
            print(f"[SECURITY OTP RESEND] New code generated for {email}: {'[DEMO: ' + new_otp + ']' if DEMO_OTP_MODE else '[SENT BY EMAIL]'}", file=sys.stdout)
            
            resp_data = {
                "success": True, 
                "message": "New verification code generated." if DEMO_OTP_MODE else "New verification code sent to your email.",
                "expires_in_seconds": 600 if DEMO_OTP_MODE else 300,
                "demo_mode": DEMO_OTP_MODE
            }
            if DEMO_OTP_MODE:
                resp_data["demo_otp"] = new_otp
                
            return self._send_json(resp_data)

        elif path == '/api/auth/send-login-otp':
            email = req_data.get('email', '').strip().lower()
            if not email or '@' not in email:
                return self._send_json({"error": "Please enter a valid email address."}, 400)
                
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT id FROM users WHERE email = ?", (email,))
                user = cursor.fetchone()
                now = int(time.time())
                
                cursor.execute("SELECT created_at FROM otps WHERE email = ?", (email,))
                existing_otp = cursor.fetchone()
                if not DEMO_OTP_MODE and existing_otp and (now - existing_otp['created_at']) < 30:
                    wait_time = 30 - (now - existing_otp['created_at'])
                    return self._send_json({"error": f"Please wait {wait_time}s before requesting a new code."}, 429)
                
                otp_code = generate_secure_otp()
                otp_h, otp_salt = hash_otp(otp_code)
                expires_at = now + (10 * 60) if DEMO_OTP_MODE else now + (5 * 60)
                
                if not DEMO_OTP_MODE:
                    sent_ok, err_reason = send_email_otp(email, otp_code)
                    if not sent_ok:
                        return self._send_json({
                            "error": "We couldn't send the verification email. Please try again.",
                            "details": err_reason,
                            "email_delivery_failed": True
                        }, 502)
                
                if not user:
                    user_id = f"USR_{int(time.time())}_{secrets.token_hex(4)}"
                    cursor.execute('''
                        INSERT INTO users (id, email, email_verified, setup_completed, created_at)
                        VALUES (?, ?, 0, 0, ?)
                    ''', (user_id, email, now))
                
                cursor.execute('''
                    INSERT OR REPLACE INTO otps (email, otp_hash, salt, expires_at, attempts, created_at)
                    VALUES (?, ?, ?, ?, 0, ?)
                ''', (email, otp_h, otp_salt, expires_at, now))
                conn.commit()
                
            print(f"[SECURITY LOGIN OTP] Login code generated for {email}: {'[DEMO: ' + otp_code + ']' if DEMO_OTP_MODE else '[SENT BY EMAIL]'}", file=sys.stdout)
            
            resp_data = {
                "success": True,
                "message": "Login code generated for demo." if DEMO_OTP_MODE else "Login code sent to your email.",
                "masked_email": mask_email(email),
                "expires_in_seconds": 600 if DEMO_OTP_MODE else 300,
                "demo_mode": DEMO_OTP_MODE
            }
            if DEMO_OTP_MODE:
                resp_data["demo_otp"] = otp_code
                
            return self._send_json(resp_data)

        elif path == '/api/auth/login':
            identifier = req_data.get('identifier', '').strip()
            password = req_data.get('password', '')
            
            if not identifier or not password:
                return self._send_json({"error": "Please enter both credentials."}, 400)
                
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute('''
                    SELECT * FROM users 
                    WHERE email = ? OR mobile = ?
                ''', (identifier.lower(), identifier.replace(' ', '')))
                user = cursor.fetchone()
                
                if not user:
                    return self._send_json({
                        "error": "No EXPIREDNOT account was found. Please create an account.",
                        "not_found": True
                    }, 404)
                    
                user_dict = dict(user)
                
                # Handle accounts created via Google OAuth or passwordless OTP
                if not user_dict.get('password_hash') or not user_dict.get('salt'):
                    if user_dict.get('auth_provider') == 'google':
                        return self._send_json({
                            "error": "This account uses Google Sign-In. Please continue with Google.",
                            "is_google_account": True
                        }, 400)
                    else:
                        return self._send_json({
                            "error": "This account was created with an external provider or email link. Please sign in using your provider or reset your password.",
                            "needs_password_reset": True
                        }, 400)
                    
                if not verify_password(password, user_dict.get('password_hash'), user_dict.get('salt')):
                    return self._send_json({"error": "Email or password is incorrect."}, 400)
                    
                if not user_dict.get('email_verified'):
                    return self._send_json({
                        "error": "Email address not yet verified.",
                        "needs_verification": True,
                        "email": user_dict.get('email')
                    }, 403)
                    
                if not user_dict.get('setup_completed'):
                    now = int(time.time())
                    token = secrets.token_hex(32)
                    cursor.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", (token, user_dict['id'], now + 86400, now))
                    conn.commit()
                    clean_user = sanitize_user(user_dict)
                    return self._send_json({
                        "success": True,
                        "needs_setup": True,
                        "session_token": token,
                        "user": clean_user
                    })
                    
                now = int(time.time())
                token = secrets.token_hex(32)
                cursor.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", (token, user_dict['id'], now + (30 * 86400), now))
                conn.commit()
                
            return self._send_json({
                "success": True,
                "session_token": token,
                "user": sanitize_user(user_dict)
            })

        elif path == '/api/auth/google':
            credential = req_data.get('credential', '')
            email = req_data.get('email', '').strip().lower()
            name = req_data.get('name', '').strip()
            
            if credential:
                try:
                    token_url = f"https://oauth2.googleapis.com/tokeninfo?id_token={urllib.parse.quote(credential)}"
                    req = urllib.request.Request(token_url, headers={'User-Agent': 'EXPIREDNOT-Server'})
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        g_data = json.loads(resp.read().decode('utf-8'))
                        email = g_data.get('email', '').strip().lower()
                        name = g_data.get('name', '') or name
                except Exception as e:
                    print(f"[GOOGLE TOKEN VERIFICATION NOTE]: {e}")
                    if not email:
                        return self._send_json({"error": "Google identity verification failed."}, 400)
            
            if not email or '@' not in email:
                return self._send_json({"error": "A valid Google email address is required."}, 400)
                
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM users WHERE email = ?", (email,))
                user = cursor.fetchone()
                now = int(time.time())
                
                if user and user['setup_completed']:
                    token = secrets.token_hex(32)
                    cursor.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", (token, user['id'], now + (30 * 86400), now))
                    conn.commit()
                    return self._send_json({
                        "success": True,
                        "existing_user": True,
                        "session_token": token,
                        "user": sanitize_user(user)
                    })
                else:
                    user_id = user['id'] if user else f"USR_G_{int(time.time())}_{secrets.token_hex(4)}"
                    if not user:
                        cursor.execute('''
                            INSERT INTO users (id, email, email_verified, setup_completed, owner_name, auth_provider, created_at)
                            VALUES (?, ?, 1, 0, ?, 'google', ?)
                        ''', (user_id, email, name, now))
                    else:
                        cursor.execute("UPDATE users SET email_verified = 1, auth_provider = 'google' WHERE id = ?", (user_id,))
                    
                    token = secrets.token_hex(32)
                    cursor.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", (token, user_id, now + 86400, now))
                    conn.commit()
                    
                    cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
                    u_row = cursor.fetchone()
                    
                    return self._send_json({
                        "success": True,
                        "new_user": True,
                        "needs_setup": True,
                        "email": email,
                        "name": name,
                        "session_token": token,
                        "user": sanitize_user(u_row)
                    })

        elif path == '/api/auth/firebase':
            email = req_data.get('email', '').strip().lower()
            uid = req_data.get('uid', '').strip()
            name = req_data.get('name', '').strip()
            id_token = req_data.get('id_token') or req_data.get('idToken') or ''
            shop_name = req_data.get('shop_name', '').strip()
            dl_number = req_data.get('dl_number', '').strip()
            shop_address = req_data.get('shop_address', '').strip()
            city = req_data.get('city', '').strip()
            state = req_data.get('state', '').strip()
            pincode = req_data.get('pincode', '').strip()
            pharmacy_type = req_data.get('pharmacy_type', 'Retail Pharmacy')
            owner_name = req_data.get('owner_name', name).strip()
            role = req_data.get('role', 'Owner')
            mobile = req_data.get('mobile', '').strip()
            
            if not email or '@' not in email:
                return self._send_json({"error": "A valid email address is required."}, 400)
                
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM users WHERE email = ?", (email,))
                user = cursor.fetchone()
                now = int(time.time())
                
                if user:
                    token = secrets.token_hex(32)
                    cursor.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", (token, user['id'], now + (30 * 86400), now))
                    cursor.execute("UPDATE users SET email_verified = 1 WHERE id = ?", (user['id'],))
                    conn.commit()
                    return self._send_json({
                        "success": True,
                        "existing_user": True,
                        "needs_setup": not bool(user['setup_completed']),
                        "session_token": token,
                        "user": sanitize_user(user)
                    })
                else:
                    setup_done = 1 if (shop_name and dl_number) else 0
                    user_id = f"USR_FB_{int(time.time())}_{secrets.token_hex(4)}"
                    cursor.execute('''
                        INSERT INTO users (id, email, email_verified, setup_completed, shop_name, dl_number, shop_address, city, state, pincode, pharmacy_type, owner_name, role, mobile, auth_provider, created_at)
                        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'firebase', ?)
                    ''', (user_id, email, setup_done, shop_name or None, dl_number or None, shop_address or None, city or None, state or None, pincode or None, pharmacy_type, owner_name, role, mobile or None, now))
                    
                    token = secrets.token_hex(32)
                    cursor.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", (token, user_id, now + (30 * 86400), now))
                    conn.commit()
                    
                    cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
                    u_row = cursor.fetchone()
                    
                    return self._send_json({
                        "success": True,
                        "new_user": not bool(setup_done),
                        "needs_setup": not bool(setup_done),
                        "email": email,
                        "name": owner_name,
                        "session_token": token,
                        "user": sanitize_user(u_row)
                    })

        elif path == '/api/onboarding/complete':
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized session."}, 401)
                
            shop_name = req_data.get('shop_name', '').strip()
            dl_number = req_data.get('dl_number', '').strip()
            shop_address = req_data.get('shop_address', '').strip()
            city = req_data.get('city', '').strip()
            state = req_data.get('state', '').strip()
            pincode = req_data.get('pincode', '').strip()
            pharmacy_type = req_data.get('pharmacy_type', 'Retail Pharmacy')
            owner_name = req_data.get('owner_name', user.get('owner_name', '')).strip()
            role = req_data.get('role', 'Owner')
            mobile = req_data.get('mobile', '').strip()
            
            if not shop_name or not dl_number:
                return self._send_json({"error": "Pharmacy Name and D.L. Number are required."}, 400)
                
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute('''
                    UPDATE users 
                    SET shop_name = ?, dl_number = ?, shop_address = ?, city = ?, state = ?, pincode = ?, 
                        pharmacy_type = ?, owner_name = ?, role = ?, mobile = ?, setup_completed = 1
                    WHERE id = ?
                ''', (shop_name, dl_number, shop_address, city, state, pincode, pharmacy_type, owner_name, role, mobile, user['id']))
                
                cursor.execute('''
                    INSERT INTO notifications (id, user_id, text, type, is_read, created_at)
                    VALUES (?, ?, ?, 'system', 0, ?)
                ''', (f"NOTIF_{int(time.time())}", user['id'], f"Welcome to EXPIREDNOT, {shop_name}! Your pharmacy workspace is ready.", int(time.time())))
                
                conn.commit()
                
                cursor.execute("SELECT * FROM users WHERE id = ?", (user['id'],))
                updated_user = cursor.fetchone()
                
            return self._send_json({"success": True, "user": sanitize_user(updated_user)})

        elif path == '/api/bills/confirm':
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized session."}, 401)
                
            distributor = (req_data.get('distributor') or 'Unspecified Supplier').strip()
            invoice_no = (req_data.get('invoice_no') or 'UNSPECIFIED').strip()
            invoice_date = req_data.get('invoice_date') or time.strftime('%Y-%m-%d')
            items = req_data.get('items', [])
            bill_id = req_data.get('bill_id') or f"BILL_{uuid.uuid4().hex}"
            original_file_url = req_data.get('original_file_url') or f"/api/bills/{bill_id}/document"
            
            if not items:
                return self._send_json({"error": "Cannot confirm bill with zero line items."}, 400)
                
            # Validate every line item has medicine name, batch number, and expiry date
            for idx, it in enumerate(items):
                i_name = (it.get('name') or '').strip()
                i_batch = (it.get('batch_no') or it.get('batchNo') or '').strip()
                i_exp = (it.get('expiry_date') or it.get('expiryDate') or '').strip()
                if not i_name:
                    return self._send_json({"error": f"Item #{idx+1} is missing a medicine name."}, 400)
                if not i_batch:
                    return self._send_json({"error": f"Item '{i_name}' is missing a batch number."}, 400)
                if not i_exp:
                    return self._send_json({"error": f"Item '{i_name}' is missing an expiry date."}, 400)
                
            now = int(time.time())
            total_bill_amount = sum(float(i.get('quantity', 0)) * float(i.get('purchase_rate', 0)) for i in items)
            
            seller_data_raw = req_data.get('seller_data')
            if isinstance(seller_data_raw, dict):
                seller_data_str = json.dumps(seller_data_raw)
            elif isinstance(seller_data_raw, str):
                seller_data_str = seller_data_raw
            else:
                s_dict = {}
                if req_data.get('seller_address'): s_dict['address'] = req_data.get('seller_address')
                if req_data.get('seller_phone'): s_dict['phone'] = req_data.get('seller_phone')
                if req_data.get('seller_gstin'): s_dict['gstin'] = req_data.get('seller_gstin')
                if req_data.get('seller_dl'): s_dict['dl_number'] = req_data.get('seller_dl')
                if req_data.get('place'): s_dict['place'] = req_data.get('place')
                if req_data.get('city'): s_dict['city'] = req_data.get('city')
                if req_data.get('state'): s_dict['state'] = req_data.get('state')
                seller_data_str = json.dumps(s_dict) if s_dict else None

            buyer_data_raw = req_data.get('buyer_data')
            buyer_data_str = json.dumps(buyer_data_raw) if isinstance(buyer_data_raw, dict) else (buyer_data_raw if isinstance(buyer_data_raw, str) else None)

            taxes_data_raw = req_data.get('taxes_data')
            taxes_data_str = json.dumps(taxes_data_raw) if isinstance(taxes_data_raw, dict) else (taxes_data_raw if isinstance(taxes_data_raw, str) else None)

            file_name = req_data.get('file_name') or (os.path.basename(original_file_url) if original_file_url else '')
            file_type = req_data.get('file_type') or (os.path.splitext(file_name)[1].lstrip('.').lower() if file_name else '')

            try:
                with get_db() as conn:
                    cursor = conn.cursor()
                    
                    # Idempotency / Double Submission Protection
                    cursor.execute("SELECT id, total_amount, invoice_no FROM bills WHERE id = ? AND user_id = ?", (bill_id, user['id']))
                    existing_bill = cursor.fetchone()
                    if existing_bill:
                        return self._send_json({
                            "success": True,
                            "bill_id": bill_id,
                            "already_confirmed": True,
                            "items_added": len(items),
                            "total_amount": existing_bill['total_amount']
                        })

                    # Level 2 Duplicate Check: Prevent duplicate confirmed bills with identical Supplier & Invoice No unless user explicitly overrides
                    allow_dup = req_data.get('allow_duplicate', False)
                    if not allow_dup and invoice_no != 'UNSPECIFIED' and distributor != 'Unspecified Supplier':
                        cursor.execute('''
                            SELECT id, invoice_no, distributor FROM bills
                            WHERE user_id = ? AND UPPER(TRIM(invoice_no)) = ? AND UPPER(TRIM(distributor)) = ? AND id != ?
                        ''', (user['id'], invoice_no.strip().upper(), distributor.strip().upper(), bill_id))
                        existing_meta = cursor.fetchone()
                        if existing_meta:
                            return self._send_json({
                                "error": f"A purchase bill from '{distributor}' with Invoice #{invoice_no} already exists in your records.",
                                "possible_duplicate": True,
                                "existing_bill_id": existing_meta['id']
                            }, 409)

                    # Update user_id for stored document in bill_documents
                    cursor.execute("UPDATE bill_documents SET user_id = ? WHERE bill_id = ?", (user['id'], bill_id))

                    # Insert Bill
                    cursor.execute('''
                        INSERT INTO bills (
                            id, user_id, distributor, seller_data, buyer_data, invoice_no, invoice_date, total_amount, taxes_data, original_file_path, file_name, file_type, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (bill_id, user['id'], distributor, seller_data_str, buyer_data_str, invoice_no, invoice_date, total_bill_amount, taxes_data_str, original_file_url, file_name, file_type, now))
                    
                    for idx, item in enumerate(items):
                        batch_id = f"B_{uuid.uuid4().hex}"
                        name = item.get('name', '').strip()
                        if not name:
                            continue
                        pack = item.get('pack') or 'Standard'
                        batch_no = (item.get('batch_no') or item.get('batchNo') or '').strip().upper()
                        expiry_date = (item.get('expiry_date') or item.get('expiryDate') or '').strip()
                        qty = float(item.get('quantity', 1))
                        rate = float(item.get('purchase_rate', 0))
                        raw_mrp = item.get('mrp')
                        mrp = float(raw_mrp) if raw_mrp is not None and str(raw_mrp).strip().lower() not in ('null', 'none', '') else rate
                        rack = item.get('rack', f"Rack {chr(65 + idx % 4)}-1")
                        
                        cursor.execute('''
                            INSERT INTO batches (id, user_id, bill_id, name, generic_name, pack, batch_no, expiry_date, quantity, purchase_rate, mrp, rack, distributor, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ''', (batch_id, user['id'], bill_id, name, item.get('generic_name'), pack, batch_no, expiry_date, qty, rate, mrp, rack, distributor, now))
                        
                        mov_id = f"MOV_{uuid.uuid4().hex}"
                        cursor.execute('''
                            INSERT INTO movements (id, user_id, type, medicine_name, batch_no, quantity, value, notes, created_at)
                            VALUES (?, ?, 'Purchased', ?, ?, ?, ?, ?, ?)
                        ''', (mov_id, user['id'], name, batch_no, qty, qty * rate, f"Invoice #{invoice_no}", now))
                    
                    notif_id = f"NOTIF_{uuid.uuid4().hex}"
                    cursor.execute('''
                        INSERT INTO notifications (id, user_id, text, type, is_read, created_at)
                        VALUES (?, ?, ?, 'BILL_ADDED', 0, ?)
                    ''', (notif_id, user['id'], f"New Bill Added: Invoice #{invoice_no} ({distributor}) added to inventory ({len(items)} medicines, ₹{total_bill_amount:,.2f}).", now))
                    
                    conn.commit()
                    
                return self._send_json({
                    "success": True,
                    "bill_id": bill_id,
                    "items_added": len(items),
                    "total_amount": total_bill_amount
                })
            except Exception as e:
                print(f"[BILL CONFIRM ERROR] Database transaction failed: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc()
                return self._send_json({"error": "Couldn't save this bill completely. No inventory changes were made. Please try again."}, 500)

        elif path == '/api/notifications/read':
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized session."}, 401)
            notif_id = req_data.get('id')
            mark_all = req_data.get('all', False)
            with get_db() as conn:
                cursor = conn.cursor()
                if mark_all:
                    cursor.execute("UPDATE notifications SET is_read = 1 WHERE user_id = ?", (user['id'],))
                elif notif_id:
                    cursor.execute("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?", (notif_id, user['id']))
                conn.commit()
            return self._send_json({"success": True})

        elif path == '/api/inventory/sell':
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized session."}, 401)
            batch_id = (req_data.get('batch_id') or '').strip()
            try:
                qty_to_sell = float(req_data.get('quantity', 0))
            except (ValueError, TypeError):
                qty_to_sell = 0
            notes = (req_data.get('notes') or '').strip()

            if not batch_id or qty_to_sell <= 0:
                return self._send_json({"error": "Invalid batch or quantity to sell."}, 400)

            try:
                with get_db() as conn:
                    cursor = conn.cursor()
                    cursor.execute("SELECT * FROM batches WHERE id = ? AND user_id = ?", (batch_id, user['id']))
                    batch = cursor.fetchone()
                    if not batch:
                        return self._send_json({"error": "Batch not found in active inventory."}, 404)

                    available_qty = float(batch['quantity'])
                    if qty_to_sell > available_qty:
                        return self._send_json({"error": f"Cannot sell {qty_to_sell:g} units. Only {available_qty:g} units available in stock."}, 400)

                    new_qty = available_qty - qty_to_sell
                    cursor.execute("UPDATE batches SET quantity = ? WHERE id = ? AND user_id = ?", (new_qty, batch_id, user['id']))

                    now = int(time.time())
                    mov_id = f"MOV_{uuid.uuid4().hex}"
                    rate = float(batch['purchase_rate'] or 0)
                    mrp = float(batch['mrp'] or rate)
                    sale_value = qty_to_sell * mrp

                    cursor.execute('''
                        INSERT INTO movements (id, user_id, type, medicine_name, batch_no, quantity, value, notes, created_at)
                        VALUES (?, ?, 'Sold', ?, ?, ?, ?, ?, ?)
                    ''', (mov_id, user['id'], batch['name'], batch['batch_no'], qty_to_sell, sale_value, notes or f"Stock Clearance Sale (Batch: {batch['batch_no']})", now))

                    if new_qty == 0:
                        notif_text = f"Batch Sold Out: {batch['name']} (Batch {batch['batch_no']}) is now fully sold out and cleared from active inventory."
                    else:
                        notif_text = f"Stock Sold: {qty_to_sell:g} units of {batch['name']} (Batch {batch['batch_no']}) marked as sold. {new_qty:g} remaining."

                    notif_id = f"NOTIF_{uuid.uuid4().hex}"
                    cursor.execute('''
                        INSERT INTO notifications (id, user_id, text, type, is_read, created_at)
                        VALUES (?, ?, ?, 'SOLD_STOCK', 0, ?)
                    ''', (notif_id, user['id'], notif_text, now))

                    conn.commit()

                return self._send_json({
                    "success": True,
                    "batch_id": batch_id,
                    "sold_quantity": qty_to_sell,
                    "remaining_quantity": new_qty,
                    "movement_id": mov_id,
                    "message": notif_text
                })
            except Exception as e:
                print(f"[INVENTORY SELL ERROR] Transaction failed: {e}", file=sys.stderr)
                return self._send_json({"error": "Failed to complete stock sale. No changes were made."}, 500)

        elif path == '/api/profile/update':
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized session."}, 401)

            owner_name = (req_data.get('owner_name') or user.get('owner_name') or '').strip()
            mobile = (req_data.get('mobile') or user.get('mobile') or '').strip()
            shop_name = (req_data.get('shop_name') or user.get('shop_name') or '').strip()
            dl_number = (req_data.get('dl_number') or user.get('dl_number') or '').strip()
            shop_address = (req_data.get('shop_address') or user.get('shop_address') or '').strip()
            city = (req_data.get('city') or user.get('city') or '').strip()
            state = (req_data.get('state') or user.get('state') or '').strip()
            pincode = (req_data.get('pincode') or user.get('pincode') or '').strip()
            pharmacy_type = (req_data.get('pharmacy_type') or user.get('pharmacy_type') or 'Retail Pharmacy').strip()

            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute('''
                    UPDATE users
                    SET owner_name = ?, mobile = ?, shop_name = ?, dl_number = ?, shop_address = ?, city = ?, state = ?, pincode = ?, pharmacy_type = ?
                    WHERE id = ?
                ''', (owner_name, mobile, shop_name, dl_number, shop_address, city, state, pincode, pharmacy_type, user['id']))
                conn.commit()
                cursor.execute("SELECT * FROM users WHERE id = ?", (user['id'],))
                updated_user = cursor.fetchone()

            return self._send_json({"success": True, "user": sanitize_user(updated_user)})

        elif path == '/api/profile/photo':
            user = self._get_auth_user()
            if not user:
                return self._send_json({"error": "Unauthorized session."}, 401)

            photo_data = (req_data.get('photo') or '').strip()
            if not photo_data:
                return self._send_json({"error": "No image data provided."}, 400)
            if not photo_data.startswith(('data:image/jpeg;base64,', 'data:image/png;base64,', 'data:image/webp;base64,', 'data:image/jpg;base64,')):
                return self._send_json({"error": "Invalid image format. Allowed formats: JPEG, PNG, WEBP."}, 400)
            if len(photo_data) > 4 * 1024 * 1024:
                return self._send_json({"error": "Image file too large. Maximum size is 3MB."}, 400)

            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("UPDATE users SET profile_photo = ? WHERE id = ?", (photo_data, user['id']))
                conn.commit()
                cursor.execute("SELECT * FROM users WHERE id = ?", (user['id'],))
                updated_user = cursor.fetchone()

            return self._send_json({"success": True, "user": sanitize_user(updated_user)})

        elif path == '/api/auth/logout':
            auth_header = self.headers.get('Authorization', '')
            if auth_header.startswith('Bearer '):
                token = auth_header[7:].strip()
                with get_db() as conn:
                    cursor = conn.cursor()
                    cursor.execute("DELETE FROM sessions WHERE token = ?", (token,))
                    conn.commit()
            return self._send_json({"success": True, "message": "Logged out."})

        return self._send_json({"error": "Endpoint not found."}, 404)

def app(environ, start_response):
    """
    WSGI callable entrypoint for Gunicorn/Render deployments (gunicorn server:app).
    """
    import io
    from http.client import HTTPMessage
    
    class WSGIHandler(ExpiredNotHandler):
        def __init__(self, req_env):
            self.environ = req_env
            self.headers_set = []
            self.status_line = "200 OK"
            self.output = io.BytesIO()
            self.rfile = req_env['wsgi.input']
            self.wfile = self.output
            self.command = req_env['REQUEST_METHOD']
            self.path = req_env.get('PATH_INFO', '/')
            if req_env.get('QUERY_STRING'):
                self.path += '?' + req_env['QUERY_STRING']
            self.request_version = "HTTP/1.1"
            self.close_connection = True
            
            self.headers = HTTPMessage()
            for key, val in req_env.items():
                if key.startswith('HTTP_'):
                    h_name = key[5:].replace('_', '-').title()
                    self.headers.add_header(h_name, str(val))
                elif key in ('CONTENT_TYPE', 'CONTENT_LENGTH'):
                    h_name = key.replace('_', '-').title()
                    self.headers.add_header(h_name, str(val))
            
            if self.command == 'GET':
                self.do_GET()
            elif self.command == 'POST':
                self.do_POST()
            elif self.command == 'OPTIONS':
                self.do_OPTIONS()

        def send_response(self, code, message=None):
            status_phrases = {
                200: "OK", 201: "Created", 204: "No Content",
                400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
                404: "Not Found", 405: "Method Not Allowed", 409: "Conflict",
                422: "Unprocessable Entity", 429: "Too Many Requests",
                500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable"
            }
            phrase = message or status_phrases.get(code, "OK")
            self.status_line = f"{code} {phrase}"

        def send_header(self, keyword, value):
            self.headers_set.append((keyword, str(value)))

        def end_headers(self):
            pass

    try:
        handler = WSGIHandler(environ)
        start_response(handler.status_line, handler.headers_set)
        return [handler.output.getvalue()]
    except Exception as exc:
        import traceback
        traceback.print_exc()
        err_body = json.dumps({"error": f"WSGI Handler Error: {str(exc)}"}).encode('utf-8')
        start_response("500 Internal Server Error", [
            ("Content-Type", "application/json"),
            ("Content-Length", str(len(err_body))),
            ("Access-Control-Allow-Origin", "*")
        ])
        return [err_body]

def run_server():
    server_address = ('', PORT)
    httpd = ThreadingHTTPServer(server_address, ExpiredNotHandler)
    print(f"============================================================")
    print(f" EXPIREDNOT Production Server running at http://localhost:{PORT}")
    print(f" Database: {DB_PATH}")
    print(f" Uploads: {UPLOADS_DIR}")
    print(f" Gemini AI Service: {'Active' if GEMINI_API_KEY else 'Standby (Configure GEMINI_API_KEY for live extraction)'}")
    print(f"============================================================")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer shutting down gracefully.")
        httpd.server_close()

if __name__ == '__main__':
    run_server()
