#!/usr/bin/env python3
"""Helper script to obtain Azure AD test token for authentication testing.

Requires:
    pip install msal python-dotenv

Usage:
    python get_test_token.py

The script will:
1. Load Azure AD config from .env
2. Open a browser for interactive login
3. Display the access token for testing

Use the token in API requests:
    curl -H "Authorization: Bearer <token>" http://localhost:8000/api/me
"""
import os
import sys
from dotenv import load_dotenv

try:
    from msal import PublicClientApplication
except ImportError:
    print("Error: msal library not found")
    print("Install it with: pip install msal")
    sys.exit(1)

# Load environment variables
load_dotenv()

tenant_id = os.getenv("AZURE_AD_TENANT_ID")
client_id = os.getenv("AZURE_AD_CLIENT_ID")

if not tenant_id or not client_id:
    print("Error: Missing Azure AD configuration")
    print("Please set AZURE_AD_TENANT_ID and AZURE_AD_CLIENT_ID in .env file")
    sys.exit(1)

print("=" * 70)
print("Azure AD Test Token Generator")
print("=" * 70)
print(f"\nTenant ID: {tenant_id}")
print(f"Client ID: {client_id}")
print("\nThis will open a browser for you to sign in with your Microsoft account.")
print("Press Ctrl+C to cancel.\n")

try:
    # Create MSAL public client application
    app = PublicClientApplication(
        client_id,
        authority=f"https://login.microsoftonline.com/{tenant_id}"
    )

    # Get token interactively
    print("Opening browser for authentication...")
    result = app.acquire_token_interactive(
        scopes=[f"{client_id}/.default"]
    )

    if "access_token" in result:
        print("\n" + "=" * 70)
        print("✅ Authentication successful!")
        print("=" * 70)
        print("\nAccess Token:")
        print("-" * 70)
        print(result["access_token"])
        print("-" * 70)

        # Show token info
        print("\nToken Info:")
        print(f"  Expires in: {result.get('expires_in', 'unknown')} seconds")
        if "id_token_claims" in result:
            claims = result["id_token_claims"]
            print(f"  User: {claims.get('name', 'unknown')}")
            print(f"  Email: {claims.get('preferred_username', 'unknown')}")

        print("\nTest the token:")
        print("  curl -H 'Authorization: Bearer <token>' http://localhost:8000/api/me")

        # Optionally save to file
        save = input("\nSave token to test_token.txt? (y/n): ")
        if save.lower() == 'y':
            with open('test_token.txt', 'w') as f:
                f.write(result["access_token"])
            print("✅ Token saved to test_token.txt")
            print("\nUse it with:")
            print("  curl -H \"Authorization: Bearer $(cat test_token.txt)\" http://localhost:8000/api/me")

    else:
        print("\n❌ Authentication failed!")
        print(f"Error: {result.get('error')}")
        print(f"Description: {result.get('error_description')}")
        sys.exit(1)

except KeyboardInterrupt:
    print("\n\nCancelled by user")
    sys.exit(0)

except Exception as e:
    print(f"\n❌ Error: {e}")
    sys.exit(1)
