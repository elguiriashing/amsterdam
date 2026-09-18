# Registration v2 deployment and setup

Frontend: elguiriashing/amsterdam-frontend (Cloudflare Pages). Backend: elguiriashing/amsterdam (Railway), MongoDB Atlas Amsterdam0.

## Deployment order
1. Deploy the backend and confirm `/api/registration/config` returns version 2.
2. Deploy the frontend. Staff login -> Registration desk.
3. The owner must check the physical membership register and set the next unused number. The system rejects numbers at or below the highest digital legacy member number. It cannot know numbers used only on paper.
4. Reserve a number in the desk BEFORE writing a paper membership. Once numbering is initialised, never allocate numbers offline without a previously reserved number. Reprints keep the original number. Deleted registrations do not free their numbers.

## Private Cloudflare R2
Use a separate bucket in the existing Cloudflare account, e.g. amsterdam-private-ids. Existing account billing can cover this usage; storage is not automatically free. Keep public access and r2.dev disabled. Prefer an EU-jurisdiction bucket if appropriate for the club's arrangements. Create a bucket-scoped Object Read & Write API token. Enter secrets directly in Railway, never in GitHub or chat.

Railway variables:
- R2_ENDPOINT: exact S3 API endpoint shown for the bucket (including EU jurisdiction if selected).
- R2_BUCKET: bucket name.
- R2_ACCESS_KEY_ID: secret.
- R2_SECRET_ACCESS_KEY: secret.
- ID_HASH_SECRET: a stable random secret (32+ bytes). Optional; defaults to JWT_SECRET. Set before enrolling new members; changing it disrupts ID duplicate checks.
- ID_OCR_ENABLED=true: optional, enables Tesseract on the Railway backend. Defaults off. The engine downloads its language model on first use; allow outbound access and sufficient CPU/memory. No ID is sent to an external OCR service. One scan at a time per backend instance, recognition timeout 45 seconds. First model load can take longer.

Uploads go through the API; no bucket CORS or public image domain is needed. Supports JPEG/PNG/WebP, maximum 8 MB and 40 MP input. Re-encodes to JPEG with metadata stripped and max 1800 pixels. HEIC users should export JPEG. Staff can photograph/capture on their device then select the image.

Before enabling ID collection, the club must decide whether retaining/printing full copies is necessary, provide its complete controller/legal-basis/rights/retention information and update registration-privacy.html accordingly. The included page is a functional collection notice, not legal certification. ID upload is optional so in-person inspection remains available.

## Retention and privacy
- Incomplete new pre-fills: delete after 30 days.
- Activated registration ID images: delete after 7 days.
- Cleanup runs hourly while backend is running; up to 100 records per pass, retry on storage error. Signed paper and member record retention must be governed by the club's separate policy.
- Legacy pre-fills are not retroactively expired.
- Private staff API responses use no-store. Do not add analytics/session replay to the desk. Images are never sent to Telegram. No government ID/DOB password generation.
- Staff must close print/PDF windows and manage printer spool/downloaded copies appropriately. Browser print dialog is expected; silent printing needs a separate local printer integration.

## Official membership form
The app does not invent legal wording. Supply the actual front/back as a two-page PDF. Owner uploads in desk setup, then maps fields via JSON (PDF points from bottom-left, page 0 or 1). Supported keys: firstName, surname, fullname, dob, address, email, phone, memberNumber, documentNumber, date, idImage.
Example text: {"fullname":{"page":0,"x":80,"y":700,"width":300,"size":10}}
Example image: {"idImage":{"page":1,"x":80,"y":80,"width":240,"height":150}}
Use Preview template on a prepared registration to generate a DRAFT marked sample before approving. Keep all legal text and signature areas unobstructed. Browser draft intake is clearly marked NOT the legal agreement. Printer duplex must be enabled manually as appropriate (normally long edge).
The Helvetica template font supports Western European text. Unsupported names fail explicitly rather than silently changing them; a future supplied font can expand language coverage.

## Staff workflow
1. Search pending pre-fill or create walk-in. Complete missing legacy details. Check original ID and Spanish address; postcode validation alone does not prove an address exists.
2. Optional ID OCR provides editable text and passport-MRZ suggestions, not authentication or guaranteed extraction. Check every field, then Save.
3. Check identity/address boxes, prepare. Optionally attach an existing paper reservation. Save changes invalidates review.
4. Print official form (or use existing paper with draft intake). Record the in-person signature, activate.
5. Member number is the login identifier (legacy backend `email` field). Actual contact email is stored separately. Random password is displayed once; use Reset login if lost. Existing members retain their current login.

## Validation
Runtime: Node 22 or newer. Nonbreaking dependency security updates are included. The existing SimpleWebAuthn v10 dependency retains one low-severity advisory requiring a separate major-version passkey migration; it is not silently upgraded here.
`npm ci && npm test` runs unit tests and isolated MongoDB replica-set integration tests (downloads mongod on first run). No production data or Telegram used. CI runs on push/PR. Test concurrent number reservations, idempotent submissions/activation, staff access denial, age/address checks, and private field projection.

## Known operational limits
No automatic geocoding: Spanish postcode and structured address checks plus staff confirmation. No digital signature: signed original paper required. No silent printing. ID storage and OCR require the above configuration and a real-device smoke test after setup. Rate limiting is per backend instance; shared/distributed limiting should be added before multi-instance scaling. Database transactions require replica-set MongoDB (Atlas supports this). Existing admin passkeys preserve existing behaviour. Membership term defaults to one year as before; staff can adjust in existing members management.
