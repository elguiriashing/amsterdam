# Staff ID scanning

Scan ID & fill Person reads the stored private image on the backend. It is available for pending, prepared and active registrations whenever private image storage is configured. It does not need ID_OCR_ENABLED. Results fill recognized Person fields and open that tab; staff check the original and explicitly save. No third-party service receives the photo. No OCR text is logged.

The scanner uses Tesseract locally, tries four orientations, and parses TD1/TD2/TD3 MRZ with check digits using mrz 5.0.2. Default English/MRZ trained data ships in the deployment. Extra languages are selected in the desk and downloaded/cached by Tesseract; the image stays on the backend. Printed field labels in English, Spanish, French, German, Italian, Portuguese and Dutch provide a fallback without checksum validation. Unknown fields stay blank. Ambiguous printed birth dates are not guessed.

This is not universal identity verification: glare, blur, handwritten IDs, unfamiliar layouts, unlabelled text, native-language-only labels and unsupported machine-readable formats can need manual entry. Passport MRZ uses Latin transliteration; that spelling is offered for review. National document numbers can differ from passport numbers; staff must check the intended number before saving.

Active Person corrections require staff authentication and explicit identity confirmation. They update the linked member's name and duplicate-identity hash transactionally, preserve membership number/status/balance/password, and reject IDs owned by another member. Other active fields are not editable in this flow. Password reset remains a separate action.

Tests cover MRZ fields/check failures/printed labels/blank results, active correction authorization and preservation, and a DOM test for active scan/autofill/tab/save. A generated, rotated passport specimen exercises the real OCR engine. Real international cards have not been comprehensively validated; do not promise every document type.
