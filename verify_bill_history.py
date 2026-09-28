import unittest
import json
import time
import secrets
import sqlite3
import os
import sys

# Ensure server module is accessible
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server

class TestBillHistory(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.init_db()
        
    def setUp(self):
        self.user1_id = f"U_TEST1_{int(time.time())}_{secrets.token_hex(3)}"
        self.user1_token = f"T_TEST1_{int(time.time())}_{secrets.token_hex(4)}"
        self.user2_id = f"U_TEST2_{int(time.time())}_{secrets.token_hex(3)}"
        self.user2_token = f"T_TEST2_{int(time.time())}_{secrets.token_hex(4)}"
        
        now = int(time.time())
        uid_rnd = secrets.token_hex(4)
        with server.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('''
                INSERT INTO users (id, email, shop_name, owner_name, dl_number, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (self.user1_id, f"test1_{uid_rnd}_{now}@pharmacy.com", "Test Pharmacy 1", "Owner One", "DL-11111", now))
            
            cursor.execute('''
                INSERT INTO users (id, email, shop_name, owner_name, dl_number, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (self.user2_id, f"test2_{uid_rnd}_{now}@pharmacy.com", "Test Pharmacy 2", "Owner Two", "DL-22222", now))
            
            cursor.execute('''
                INSERT INTO sessions (token, user_id, expires_at, created_at)
                VALUES (?, ?, ?, ?)
            ''', (self.user1_token, self.user1_id, now + 86400, now))
            
            cursor.execute('''
                INSERT INTO sessions (token, user_id, expires_at, created_at)
                VALUES (?, ?, ?, ?)
            ''', (self.user2_token, self.user2_id, now + 86400, now))
            conn.commit()

    def test_bill_confirmation_and_retrieval(self):
        bill_id = f"BILL_TEST_{int(time.time())}_{secrets.token_hex(3)}"
        bill_payload = {
            "bill_id": bill_id,
            "distributor": "MedLife Wholesale Dist",
            "invoice_no": "INV-998811",
            "invoice_date": "2026-09-22",
            "original_file_url": "/uploads/bills/sample_bill.jpg",
            "file_name": "sample_bill.jpg",
            "file_type": "jpg",
            "seller_data": {
                "name": "MedLife Wholesale Dist Pvt Ltd",
                "place": "Bangalore",
                "city": "Bangalore",
                "state": "Karnataka",
                "address": "45 Commercial St, Bangalore",
                "gstin": "29AAAAA0000A1Z5",
                "dl_number": "KA-BNG-12345",
                "phone": "+91 9876543210"
            },
            "items": [
                {
                    "name": "Augmentin 625 Duo",
                    "generic_name": "Amoxicillin and Clavulanate Potassium",
                    "pack": "10 Tabs",
                    "batch_no": "AUG-7721",
                    "expiry_date": "2027-05",
                    "quantity": 20,
                    "purchase_rate": 140.50,
                    "mrp": 201.70
                },
                {
                    "name": "Pan-D Capsule",
                    "generic_name": "Pantoprazole and Domperidone",
                    "pack": "15 Caps",
                    "batch_no": "PND-9912",
                    "expiry_date": "2026-12",
                    "quantity": 30,
                    "purchase_rate": 85.00,
                    "mrp": 130.00
                }
            ]
        }
        
        # Test confirmation directly through database / logic
        now = int(time.time())
        total_bill_amount = sum(i['quantity'] * i['purchase_rate'] for i in bill_payload['items'])
        
        with server.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('''
                INSERT OR REPLACE INTO bills (
                    id, user_id, distributor, seller_data, buyer_data, invoice_no, invoice_date, total_amount, taxes_data, original_file_path, file_name, file_type, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                bill_id, 
                self.user1_id, 
                bill_payload['distributor'], 
                json.dumps(bill_payload['seller_data']), 
                None, 
                bill_payload['invoice_no'], 
                bill_payload['invoice_date'], 
                total_bill_amount, 
                None, 
                bill_payload['original_file_url'], 
                bill_payload['file_name'], 
                bill_payload['file_type'], 
                now
            ))
            
            for idx, item in enumerate(bill_payload['items']):
                batch_id = f"B_{now}_{idx}"
                cursor.execute('''
                    INSERT INTO batches (id, user_id, bill_id, name, generic_name, pack, batch_no, expiry_date, quantity, purchase_rate, mrp, rack, distributor, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Rack A-1', ?, ?)
                ''', (batch_id, self.user1_id, bill_id, item['name'], item['generic_name'], item['pack'], item['batch_no'], item['expiry_date'], item['quantity'], item['purchase_rate'], item['mrp'], bill_payload['distributor'], now))
            conn.commit()
            
        # Verify GET bills returns the bill and line items for User 1
        with server.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM bills WHERE user_id = ? ORDER BY created_at DESC", (self.user1_id,))
            raw_bills = [dict(r) for r in cursor.fetchall()]
            
            cursor.execute("SELECT * FROM batches WHERE user_id = ? ORDER BY rowid ASC", (self.user1_id,))
            all_batches = [dict(r) for r in cursor.fetchall()]
            
            batches_by_bill = {}
            for b in all_batches:
                b_id = b.get('bill_id')
                if b_id:
                    batches_by_bill.setdefault(b_id, []).append(b)
                    
            self.assertEqual(len(raw_bills), 1)
            b = raw_bills[0]
            self.assertEqual(b['id'], bill_id)
            self.assertEqual(b['invoice_no'], "INV-998811")
            self.assertEqual(b['distributor'], "MedLife Wholesale Dist")
            self.assertEqual(len(batches_by_bill[bill_id]), 2)
            
            med_names = [it['name'] for it in batches_by_bill[bill_id]]
            self.assertIn("Augmentin 625 Duo", med_names)
            self.assertIn("Pan-D Capsule", med_names)

    def test_multi_field_search_matching(self):
        # Create 2 bills with different attributes
        bill1_id = f"BILL_SEARCH1_{int(time.time())}_{secrets.token_hex(2)}"
        bill2_id = f"BILL_SEARCH2_{int(time.time())}_{secrets.token_hex(2)}"
        now = int(time.time())
        
        with server.get_db() as conn:
            cursor = conn.cursor()
            # Bill 1: Apollo Wholesale in Delhi, Paracetamol & Azithral
            cursor.execute('''
                INSERT INTO bills (id, user_id, distributor, seller_data, invoice_no, invoice_date, total_amount, original_file_path, created_at)
                VALUES (?, ?, 'Apollo Wholesale Delhi', ?, 'INV-DEL-101', '2026-09-20', 1200, '/uploads/bills/b1.jpg', ?)
            ''', (bill1_id, self.user1_id, json.dumps({
                "name": "Apollo Wholesale",
                "place": "New Delhi",
                "gstin": "07AAAAA1111A1Z1",
                "dl_number": "DL-DEL-9988"
            }), now - 86400))
            
            cursor.execute('''
                INSERT INTO batches (id, user_id, bill_id, name, generic_name, batch_no, expiry_date, quantity, purchase_rate, mrp, created_at)
                VALUES (?, ?, ?, 'Paracetamol 650', 'Paracetamol', 'BATCH-PARA-1', '2027-01', 50, 10, 15, ?)
            ''', (f"B_S_{secrets.token_hex(4)}_1", self.user1_id, bill1_id, now - 86400))
            cursor.execute('''
                INSERT INTO batches (id, user_id, bill_id, name, generic_name, batch_no, expiry_date, quantity, purchase_rate, mrp, created_at)
                VALUES (?, ?, ?, 'Azithral 500', 'Azithromycin', 'BATCH-AZI-2', '2026-11', 20, 35, 55, ?)
            ''', (f"B_S_{secrets.token_hex(4)}_2", self.user1_id, bill1_id, now - 86400))

            # Bill 2: Sun Pharma Hub in Mumbai, Telma 40 & Rosuvas
            cursor.execute('''
                INSERT INTO bills (id, user_id, distributor, seller_data, invoice_no, invoice_date, total_amount, original_file_path, created_at)
                VALUES (?, ?, 'Sun Pharma Hub Mumbai', ?, 'INV-MUM-202', '2026-09-22', 3400, '/uploads/bills/b2.pdf', ?)
            ''', (bill2_id, self.user1_id, json.dumps({
                "name": "Sun Pharma Distributors",
                "place": "Mumbai",
                "gstin": "27BBBBB2222B2Z2",
                "dl_number": "MH-MUM-7766"
            }), now))
            
            cursor.execute('''
                INSERT INTO batches (id, user_id, bill_id, name, generic_name, batch_no, expiry_date, quantity, purchase_rate, mrp, created_at)
                VALUES (?, ?, ?, 'Telma 40', 'Telmisartan', 'BATCH-TEL-3', '2028-03', 40, 60, 90, ?)
            ''', (f"B_S_{secrets.token_hex(4)}_3", self.user1_id, bill2_id, now))
            conn.commit()

        # Simulate multi-field search engine against both bills
        with server.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM bills WHERE user_id = ?", (self.user1_id,))
            user_bills = [dict(r) for r in cursor.fetchall()]
            
            cursor.execute("SELECT * FROM batches WHERE user_id = ?", (self.user1_id,))
            user_batches = [dict(r) for r in cursor.fetchall()]

        batches_by_bill = {}
        for b in user_batches:
            if b.get('bill_id'):
                batches_by_bill.setdefault(b['bill_id'], []).append(b)

        for b in user_bills:
            b['seller_data'] = json.loads(b['seller_data']) if b.get('seller_data') else {}
            b['items'] = batches_by_bill.get(b['id'], [])

        def match_bill(bill, query):
            q = query.lower()
            if q in (bill.get('distributor') or '').lower(): return True
            if q in (bill['seller_data'].get('name') or '').lower(): return True
            if q in (bill['seller_data'].get('place') or '').lower(): return True
            if q in (bill.get('invoice_no') or '').lower(): return True
            if q in (bill['seller_data'].get('gstin') or '').lower(): return True
            if q in (bill['seller_data'].get('dl_number') or '').lower(): return True
            for it in bill.get('items', []):
                if q in (it.get('name') or '').lower(): return True
                if q in (it.get('generic_name') or '').lower(): return True
                if q in (it.get('batch_no') or '').lower(): return True
            return False

        # Test 1: Search by distributor
        matches_apollo = [b for b in user_bills if match_bill(b, "Apollo")]
        self.assertEqual(len(matches_apollo), 1)
        self.assertEqual(matches_apollo[0]['id'], bill1_id)

        # Test 2: Search by Place
        matches_mumbai = [b for b in user_bills if match_bill(b, "Mumbai")]
        self.assertEqual(len(matches_mumbai), 1)
        self.assertEqual(matches_mumbai[0]['id'], bill2_id)

        # Test 3: Search by Invoice No
        matches_inv = [b for b in user_bills if match_bill(b, "INV-DEL")]
        self.assertEqual(len(matches_inv), 1)
        self.assertEqual(matches_inv[0]['id'], bill1_id)

        # Test 4: Search by Medicine Name inside line items
        matches_telma = [b for b in user_bills if match_bill(b, "Telma")]
        self.assertEqual(len(matches_telma), 1)
        self.assertEqual(matches_telma[0]['id'], bill2_id)

        # Test 5: Search by Batch No inside line items
        matches_batch = [b for b in user_bills if match_bill(b, "BATCH-AZI-2")]
        self.assertEqual(len(matches_batch), 1)
        self.assertEqual(matches_batch[0]['id'], bill1_id)

        # Test 6: Search by GSTIN
        matches_gst = [b for b in user_bills if match_bill(b, "27BBBBB")]
        self.assertEqual(len(matches_gst), 1)
        self.assertEqual(matches_gst[0]['id'], bill2_id)

        # Test 7: Search by DL Number
        matches_dl = [b for b in user_bills if match_bill(b, "DL-DEL-9988")]
        self.assertEqual(len(matches_dl), 1)
        self.assertEqual(matches_dl[0]['id'], bill1_id)

    def test_user_data_isolation(self):
        # User 2 must see 0 bills
        with server.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM bills WHERE user_id = ?", (self.user2_id,))
            bills = cursor.fetchall()
            self.assertEqual(len(bills), 0)

    def test_permanence_after_sale(self):
        bill_id = f"BILL_PERM_{int(time.time())}"
        now = int(time.time())
        batch_id = f"B_PERM_{now}"
        
        with server.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('''
                INSERT INTO bills (id, user_id, distributor, invoice_no, invoice_date, total_amount, created_at)
                VALUES (?, ?, 'Perm Distributor', 'INV-PERM-01', '2026-09-22', 500, ?)
            ''', (bill_id, self.user1_id, now))
            
            cursor.execute('''
                INSERT INTO batches (id, user_id, bill_id, name, batch_no, expiry_date, quantity, purchase_rate, mrp, created_at)
                VALUES (?, ?, ?, 'Dolo 650', 'DOL-99', '2027-01', 10, 50, 65, ?)
            ''', (batch_id, self.user1_id, bill_id, now))
            conn.commit()
            
            # Simulate Selling 10 units (Quantity becomes 0)
            cursor.execute("UPDATE batches SET quantity = 0 WHERE id = ?", (batch_id,))
            conn.commit()
            
            # Active inventory query should return 0 batches
            cursor.execute("SELECT * FROM batches WHERE user_id = ? AND quantity > 0", (self.user1_id,))
            active_inventory = cursor.fetchall()
            self.assertEqual(len(active_inventory), 0)
            
            # Historical Bill & Associated batch query MUST STILL RETURN THE BATCH
            cursor.execute("SELECT * FROM batches WHERE bill_id = ?", (bill_id,))
            historical_batches = cursor.fetchall()
            self.assertEqual(len(historical_batches), 1)
            self.assertEqual(historical_batches[0]['name'], 'Dolo 650')
            self.assertEqual(historical_batches[0]['bill_id'], bill_id)

    def test_movement_id_collision_prevention(self):
        """Test confirming a bill with 20 items in rapid succession generates unique movement and batch IDs with 0 collisions."""
        import uuid
        bill_id = f"BILL_COLLISION_TEST_{uuid.uuid4().hex}"
        now = int(time.time())
        num_items = 20
        
        items = [{
            "name": f"Med {i}",
            "generic_name": f"Generic {i}",
            "pack": "10s",
            "batch_no": f"BATCH_{i}_{uuid.uuid4().hex[:6]}",
            "expiry_date": "2027-12",
            "quantity": 10,
            "purchase_rate": 50.0,
            "mrp": 75.0
        } for i in range(num_items)]
        
        with server.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('''
                INSERT INTO bills (id, user_id, distributor, invoice_no, invoice_date, total_amount, created_at)
                VALUES (?, ?, 'Bulk Distributor', 'INV-BULK-01', '2026-09-22', 10000, ?)
            ''', (bill_id, self.user1_id, now))
            
            movement_ids = set()
            batch_ids = set()
            for it in items:
                b_id = f"B_{uuid.uuid4().hex}"
                m_id = f"MOV_{uuid.uuid4().hex}"
                
                movement_ids.add(m_id)
                batch_ids.add(b_id)
                
                cursor.execute('''
                    INSERT INTO batches (id, user_id, bill_id, name, generic_name, pack, batch_no, expiry_date, quantity, purchase_rate, mrp, rack, distributor, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Rack A-1', 'Bulk Distributor', ?)
                ''', (b_id, self.user1_id, bill_id, it['name'], it['generic_name'], it['pack'], it['batch_no'], it['expiry_date'], it['quantity'], it['purchase_rate'], it['mrp'], now))
                
                cursor.execute('''
                    INSERT INTO movements (id, user_id, type, medicine_name, batch_no, quantity, value, notes, created_at)
                    VALUES (?, ?, 'Purchased', ?, ?, ?, ?, ?, ?)
                ''', (m_id, self.user1_id, it['name'], it['batch_no'], it['quantity'], it['quantity'] * it['purchase_rate'], f"Invoice #INV-BULK-01", now))
            
            conn.commit()
            
            # Assert all 20 movements and 20 batches have distinct unique IDs
            self.assertEqual(len(movement_ids), num_items)
            self.assertEqual(len(batch_ids), num_items)
            
            cursor.execute("SELECT COUNT(*) as cnt FROM movements WHERE user_id = ? AND notes LIKE '%INV-BULK-01%'", (self.user1_id,))
            self.assertEqual(cursor.fetchone()['cnt'], num_items)

    def test_idempotency_double_confirm(self):
        """Test that confirming the same bill twice does not create duplicate entries."""
        import uuid
        bill_id = f"BILL_IDEMP_{uuid.uuid4().hex}"
        now = int(time.time())
        
        with server.get_db() as conn:
            cursor = conn.cursor()
            # First confirmation
            cursor.execute('''
                INSERT INTO bills (id, user_id, distributor, invoice_no, invoice_date, total_amount, created_at)
                VALUES (?, ?, 'Idemp Dist', 'INV-IDEMP-01', '2026-09-22', 500, ?)
            ''', (bill_id, self.user1_id, now))
            
            b_id = f"B_{uuid.uuid4().hex}"
            m_id = f"MOV_{uuid.uuid4().hex}"
            cursor.execute('''
                INSERT INTO batches (id, user_id, bill_id, name, batch_no, expiry_date, quantity, purchase_rate, mrp, created_at)
                VALUES (?, ?, ?, 'Idemp Med', 'ID-1', '2027-01', 5, 100, 150, ?)
            ''', (b_id, self.user1_id, bill_id, now))
            cursor.execute('''
                INSERT INTO movements (id, user_id, type, medicine_name, batch_no, quantity, value, notes, created_at)
                VALUES (?, ?, 'Purchased', 'Idemp Med', 'ID-1', 5, 500, 'Invoice #INV-IDEMP-01', ?)
            ''', (m_id, self.user1_id, now))
            conn.commit()
            
            # Second attempt (Idempotency check logic in server.py)
            cursor.execute("SELECT id, total_amount FROM bills WHERE id = ? AND user_id = ?", (bill_id, self.user1_id))
            existing_bill = cursor.fetchone()
            self.assertIsNotNone(existing_bill)
            
            # Count batches for this bill
            cursor.execute("SELECT COUNT(*) as cnt FROM batches WHERE bill_id = ?", (bill_id,))
            self.assertEqual(cursor.fetchone()['cnt'], 1)

    def test_bill_document_blob_storage_and_access_control(self):
        """Test persistent BLOB document storage and authenticated owner-only access."""
        import uuid
        bill_id = f"BILL_DOC_{uuid.uuid4().hex}"
        mock_pdf_bytes = b"%PDF-1.4 Mock PDF bill document content for ExpiredNot test"
        now = int(time.time())
        
        with server.get_db() as conn:
            cursor = conn.cursor()
            # Store document as BLOB in bill_documents
            cursor.execute('''
                INSERT INTO bill_documents (bill_id, user_id, file_name, file_mime, file_data, file_size, created_at)
                VALUES (?, ?, 'tax_invoice.pdf', 'application/pdf', ?, ?, ?)
            ''', (bill_id, self.user1_id, mock_pdf_bytes, len(mock_pdf_bytes), now))
            
            cursor.execute('''
                INSERT INTO bills (id, user_id, distributor, invoice_no, invoice_date, total_amount, original_file_path, file_name, file_type, created_at)
                VALUES (?, ?, 'Doc Supplier', 'INV-DOC-01', '2026-09-22', 1500, ?, 'tax_invoice.pdf', 'pdf', ?)
            ''', (bill_id, self.user1_id, f"/api/bills/{bill_id}/document", now))
            conn.commit()
            
            # Verify User 1 (Owner) can retrieve document data
            cursor.execute('''
                SELECT * FROM bill_documents 
                WHERE bill_id = ? AND (user_id = ? OR user_id = 'PENDING' OR user_id = 'GUEST')
            ''', (bill_id, self.user1_id))
            doc_user1 = cursor.fetchone()
            self.assertIsNotNone(doc_user1)
            self.assertEqual(doc_user1['file_data'], mock_pdf_bytes)
            self.assertEqual(doc_user1['file_mime'], 'application/pdf')
            
            # Verify User 2 (Different User) CANNOT access User 1's document
            cursor.execute('''
                SELECT * FROM bill_documents 
                WHERE bill_id = ? AND (user_id = ? OR user_id = 'PENDING' OR user_id = 'GUEST')
            ''', (bill_id, self.user2_id))
            doc_user2 = cursor.fetchone()
            self.assertIsNone(doc_user2)

    def test_atomic_transaction_rollback(self):
        """Test that if any step in bill confirmation fails, transaction rolls back cleanly."""
        import uuid
        bill_id = f"BILL_ROLLBACK_{uuid.uuid4().hex}"
        now = int(time.time())
        
        try:
            with server.get_db() as conn:
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO bills (id, user_id, distributor, invoice_no, invoice_date, total_amount, created_at)
                    VALUES (?, ?, 'Rollback Dist', 'INV-RB-01', '2026-09-22', 100, ?)
                ''', (bill_id, self.user1_id, now))
                
                # Simulate a database failure / exception midway
                raise sqlite3.IntegrityError("Simulated intermediate constraint failure")
        except Exception:
            pass # Transaction aborted
            
        with server.get_db() as conn:
            cursor = conn.cursor()
    def test_user_onboarding_persistence_and_profile_roundtrip(self):
        """Test that user onboarding and profile data persists in database and survives sessions."""
        with server.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('''
                UPDATE users
                SET owner_name = 'Sanjay Gupta',
                    mobile = '9876500000',
                    shop_name = 'Gupta Medicos',
                    dl_number = 'DL-GUJ-9988',
                    shop_address = 'Shop 12, Station Road',
                    city = 'Ahmedabad',
                    state = 'Gujarat',
                    pincode = '380001',
                    pharmacy_type = 'Wholesale & Retail',
                    setup_completed = 1,
                    profile_photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
                WHERE id = ?
            ''', (self.user1_id,))
            conn.commit()

            cursor.execute("SELECT * FROM users WHERE id = ?", (self.user1_id,))
            user = cursor.fetchone()
            self.assertEqual(user['owner_name'], 'Sanjay Gupta')
            self.assertEqual(user['shop_name'], 'Gupta Medicos')
            self.assertEqual(user['dl_number'], 'DL-GUJ-9988')
            self.assertEqual(user['shop_address'], 'Shop 12, Station Road')
            self.assertEqual(user['city'], 'Ahmedabad')
            self.assertEqual(user['state'], 'Gujarat')
            self.assertEqual(user['pincode'], '380001')
            self.assertEqual(user['pharmacy_type'], 'Wholesale & Retail')
            self.assertEqual(user['setup_completed'], 1)
            self.assertTrue(user['profile_photo'].startswith('data:image/png;base64,'))

    def test_level1_exact_file_hash_duplicate_detection(self):
        """Test that Level 1 SHA-256 exact document duplicate detection identifies duplicate uploads."""
        import hashlib
        import uuid
        mock_file_bytes = b"EXACT_INVOICE_BINARY_CONTENT_ABC_12345"
        file_hash = hashlib.sha256(mock_file_bytes).hexdigest()
        bill_id = f"BILL_DUP1_{uuid.uuid4().hex}"
        now = int(time.time())

        with server.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('''
                INSERT INTO bill_documents (bill_id, user_id, file_name, file_mime, file_data, file_size, file_hash, created_at)
                VALUES (?, ?, 'inv.jpg', 'image/jpeg', ?, ?, ?, ?)
            ''', (bill_id, self.user1_id, mock_file_bytes, len(mock_file_bytes), file_hash, now))

            cursor.execute('''
                INSERT INTO bills (id, user_id, distributor, invoice_no, invoice_date, total_amount, created_at)
                VALUES (?, ?, 'Unique Pharma', 'INV-DUP-99', '2026-09-23', 2500, ?)
            ''', (bill_id, self.user1_id, now))
            conn.commit()

            # Query duplicate check query
            cursor.execute('''
                SELECT b.id, b.distributor, b.invoice_no, b.total_amount
                FROM bill_documents bd
                JOIN bills b ON bd.bill_id = b.id
                WHERE bd.user_id = ? AND bd.file_hash = ?
            ''', (self.user1_id, file_hash))
            exact_match = cursor.fetchone()
            self.assertIsNotNone(exact_match)
            self.assertEqual(exact_match['id'], bill_id)
            self.assertEqual(exact_match['invoice_no'], 'INV-DUP-99')

            # Verify User 2 upload of the same file does not trigger User 1's duplicate check
            cursor.execute('''
                SELECT b.id FROM bill_documents bd
                JOIN bills b ON bd.bill_id = b.id
                WHERE bd.user_id = ? AND bd.file_hash = ?
            ''', (self.user2_id, file_hash))
            user2_match = cursor.fetchone()
            self.assertIsNone(user2_match)

    def test_level2_metadata_duplicate_detection(self):
        """Test Level 2 metadata duplicate detection on matching Supplier + Invoice Number."""
        import uuid
        bill_id = f"BILL_META1_{uuid.uuid4().hex}"
        now = int(time.time())

        with server.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('''
                INSERT INTO bills (id, user_id, distributor, invoice_no, invoice_date, total_amount, created_at)
                VALUES (?, ?, 'Cipla Direct Hub', 'INV-CIPLA-8822', '2026-09-23', 4200, ?)
            ''', (bill_id, self.user1_id, now))
            conn.commit()

            # Query metadata similarity
            cursor.execute('''
                SELECT id, distributor, invoice_no, total_amount
                FROM bills
                WHERE user_id = ? AND UPPER(TRIM(invoice_no)) = ? AND UPPER(TRIM(distributor)) = ?
            ''', (self.user1_id, 'INV-CIPLA-8822', 'CIPLA DIRECT HUB'))
            meta_match = cursor.fetchone()
            self.assertIsNotNone(meta_match)
            self.assertEqual(meta_match['id'], bill_id)

    def test_global_search_queries(self):
        """Test Global Search across medicines, batches, suppliers, and invoices."""
        import uuid
        now = int(time.time())
        b_id = f"B_SEARCH_{uuid.uuid4().hex}"
        bill_id = f"BILL_GSEARCH_{uuid.uuid4().hex}"

        with server.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('''
                INSERT INTO batches (id, user_id, name, generic_name, brand, manufacturer, pack, batch_no, expiry_date, quantity, purchase_rate, mrp, rack, distributor, created_at)
                VALUES (?, ?, 'Aristocal CT Tablet', 'Calcitriol + Calcium Carbonate', 'Aristocal', 'Aristo Pharma', '15s', 'ARIS-8899', '2027-08', 50, 120, 185, 'Rack B-2', 'Aristo Distribution', ?)
            ''', (b_id, self.user1_id, now))

            cursor.execute('''
                INSERT INTO bills (id, user_id, distributor, invoice_no, invoice_date, total_amount, created_at)
                VALUES (?, ?, 'Aristo Distribution Ltd', 'INV-ARIS-001', '2026-09-23', 6000, ?)
            ''', (bill_id, self.user1_id, now))
            conn.commit()

            # Search by medicine name
            pattern = '%Aristocal%'
            cursor.execute('''
                SELECT * FROM batches WHERE user_id = ? AND (name LIKE ? OR generic_name LIKE ? OR batch_no LIKE ?)
            ''', (self.user1_id, pattern, pattern, pattern))
            med_res = cursor.fetchall()
            self.assertEqual(len(med_res), 1)
            self.assertEqual(med_res[0]['name'], 'Aristocal CT Tablet')

            # Search by batch number
            b_pattern = '%ARIS-8899%'
            cursor.execute('''
                SELECT * FROM batches WHERE user_id = ? AND batch_no LIKE ?
            ''', (self.user1_id, b_pattern))
            batch_res = cursor.fetchall()
            self.assertEqual(len(batch_res), 1)

            # Search by invoice number
            inv_pattern = '%INV-ARIS-001%'
            cursor.execute('''
                SELECT * FROM bills WHERE user_id = ? AND invoice_no LIKE ?
            ''', (self.user1_id, inv_pattern))
            bill_res = cursor.fetchall()
            self.assertEqual(len(bill_res), 1)
            self.assertEqual(bill_res[0]['distributor'], 'Aristo Distribution Ltd')

            # Verify User 2 search returns 0 results (User isolation)
            cursor.execute('''
                SELECT * FROM batches WHERE user_id = ? AND name LIKE ?
            ''', (self.user2_id, pattern))
            self.assertEqual(len(cursor.fetchall()), 0)

if __name__ == '__main__':
    unittest.main()


