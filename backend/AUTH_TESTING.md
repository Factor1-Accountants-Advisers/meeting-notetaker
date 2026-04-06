# Azure AD Authentication Testing Guide

This guide explains how to test the Azure AD JWT authentication implementation.

## Important

The app now runs natively by default for local development.
Use Docker in this guide only when you specifically need the containerized backend stack.

Preferred local backend startup:

```powershell
cd C:\Projects\meeting-notetaker\backend
uvicorn app.main:app --reload --port 8000
```

## Overview

The authentication system validates Azure AD JWT tokens using:
- **JWKS** (JSON Web Key Set) for signature verification
- **Claims validation** (expiration, issuer, audience)
- **Fail-closed security** (deny by default on any error)
- **Auto-provisioning** (creates users on first login)

## Prerequisites

### 1. Azure AD App Registration

You need an Azure AD app registration with these settings:

```
App Registration Settings:
├── Name: Meeting Note-Taker (or your choice)
├── Supported account types: Single tenant
├── Redirect URIs: (can add later for web/desktop apps)
└── API permissions: User.Read (Microsoft Graph)
```

Required values from Azure Portal:
- **Tenant ID**: Found in "Overview" tab
- **Client ID** (Application ID): Found in "Overview" tab
- **Client Secret**: Create in "Certificates & secrets" tab

### 2. Update Environment Variables

Add to your `.env` file:

```env
AZURE_AD_TENANT_ID=your-tenant-id-here
AZURE_AD_CLIENT_ID=your-client-id-here
AZURE_AD_CLIENT_SECRET=your-client-secret-here
```

**Important**: Never commit `.env` to git! Use `.env.example` as a template.

## Option 1: Get Token Using Azure CLI (Recommended for Testing)

### Install Azure CLI

```bash
# Windows (PowerShell)
winget install Microsoft.AzureCLI

# Linux
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# macOS
brew install azure-cli
```

### Get Access Token

```bash
# Login to Azure AD
az login --tenant YOUR_TENANT_ID

# Get access token
az account get-access-token --resource YOUR_CLIENT_ID --query accessToken -o tsv
```

Save the token - you'll use it in the Authorization header.

## Option 2: Get Token Using PowerShell (Windows)

```powershell
# Install MSAL.PS module
Install-Module -Name MSAL.PS -Scope CurrentUser

# Get token
$tenantId = "YOUR_TENANT_ID"
$clientId = "YOUR_CLIENT_ID"
$clientSecret = "YOUR_CLIENT_SECRET"

$secureSecret = ConvertTo-SecureString $clientSecret -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential($clientId, $secureSecret)

$token = Get-MsalToken -TenantId $tenantId -ClientId $clientId -ClientSecret $secureSecret -Scopes "https://graph.microsoft.com/.default"

Write-Host $token.AccessToken
```

## Option 3: Get Token Using cURL (Client Credentials Flow)

```bash
curl -X POST \
  "https://login.microsoftonline.com/YOUR_TENANT_ID/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "scope=YOUR_CLIENT_ID/.default" \
  -d "grant_type=client_credentials"
```

Extract the `access_token` from the JSON response.

## Option 4: Get User Token (Interactive - Best for Real Testing)

For testing with real user credentials:

```python
# test_get_token.py
from msal import PublicClientApplication

tenant_id = "YOUR_TENANT_ID"
client_id = "YOUR_CLIENT_ID"

app = PublicClientApplication(
    client_id,
    authority=f"https://login.microsoftonline.com/{tenant_id}"
)

# Interactive login
result = app.acquire_token_interactive(
    scopes=[f"{client_id}/.default"]
)

if "access_token" in result:
    print("Access Token:")
    print(result["access_token"])
else:
    print("Error:", result.get("error_description"))
```

Install dependencies:
```bash
pip install msal
python test_get_token.py
```

## Testing the Authentication Endpoint

### 1. Start the API

```bash
cd backend
docker compose up -d --build
docker compose exec api alembic upgrade head
```

### 2. Test Unauthenticated Request (Should Fail)

```bash
curl -X GET http://localhost:8000/api/me
```

Expected response (401):
```json
{
  "detail": "Authentication required"
}
```

### 3. Test with Invalid Token (Should Fail)

```bash
curl -X GET http://localhost:8000/api/me \
  -H "Authorization: Bearer invalid_token"
```

Expected response (401):
```json
{
  "detail": "Invalid authentication credentials"
}
```

### 4. Test with Valid Token (Should Succeed)

```bash
# Replace YOUR_TOKEN_HERE with actual token from Azure
curl -X GET http://localhost:8000/api/me \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

Expected response (200):
```json
{
  "id": 1,
  "email": "user@yourdomain.com",
  "name": "John Doe",
  "role": "user",
  "azure_ad_id": "abc123...",
  "created_at": "2026-03-19T12:00:00"
}
```

### 5. Verify User Auto-Provisioning

Check the database:
```bash
docker compose exec postgres psql -U meetings_user -d meetings_db \
  -c "SELECT id, email, name, azure_ad_id FROM users;"
```

You should see the user created on first successful authentication.

## Testing with Postman

1. **Create new request**
   - Method: GET
   - URL: `http://localhost:8000/api/me`

2. **Set Authorization**
   - Type: Bearer Token
   - Token: Paste your Azure AD access token

3. **Send request**
   - Should return 200 with user info

4. **Test token expiration**
   - Wait for token to expire (usually 1 hour)
   - Resend request
   - Should return 401

## Security Validation Tests

Test the OWASP security controls:

### 1. No Information Disclosure
```bash
# All these should return the SAME generic error message
curl http://localhost:8000/api/me -H "Authorization: Bearer expired_token"
curl http://localhost:8000/api/me -H "Authorization: Bearer malformed.token.here"
curl http://localhost:8000/api/me -H "Authorization: Bearer wrong_signature_token"
```

All should return: `"Invalid authentication credentials"` (no specifics)

### 2. Fail-Closed Behavior

Stop the internet connection and test:
```bash
# This should fail (cannot fetch JWKS)
curl http://localhost:8000/api/me -H "Authorization: Bearer YOUR_TOKEN"
```

Should return 401 (fail-closed, not fail-open).

### 3. Token Claims Validation

Modify a valid token (tamper with claims) and test:
```bash
# Token with modified claims should fail signature validation
curl http://localhost:8000/api/me -H "Authorization: Bearer TAMPERED_TOKEN"
```

Should return 401.

## Common Issues

### "Module not found: requests"
```bash
docker compose exec api pip install requests
# Or rebuild: docker compose up -d --build
```

### "No matching key found in JWKS"
- Check your AZURE_AD_TENANT_ID is correct
- Verify the token is for the correct tenant
- Token might be for a different Azure AD app

### "Invalid issuer"
- Token issuer must match: `https://login.microsoftonline.com/{TENANT_ID}/v2.0`
- Check token was obtained for the correct tenant

### "Invalid audience"
- Token audience must match your AZURE_AD_CLIENT_ID
- Request token with correct scope/resource

### "Token expired"
- Azure AD tokens typically expire after 1 hour
- Get a fresh token

## Logging

Check authentication logs:
```bash
docker compose logs api | grep -i "auth\|token\|jwks"
```

Successful authentication:
```
INFO: Token validated successfully for user: abc123...
INFO: Auto-provisioned new user: abc123... (first login only)
```

Failed authentication:
```
WARNING: Authentication failed: No credentials provided
WARNING: Token validation failed: expired
WARNING: No matching key found in JWKS for token kid
```

## Next Steps

Once authentication is working:
1. Protect other endpoints with `Depends(get_current_user)`
2. Implement role-based access control if needed
3. Add rate limiting for authentication endpoints
4. Set up token refresh flow for desktop/web clients
5. Configure Azure AD app for production (redirect URIs, etc.)

## Security Checklist

✅ JWT signature validated using JWKS
✅ Token expiration checked (exp claim)
✅ Issuer validated (iss claim)
✅ Audience validated (aud claim)
✅ Required claims present (oid, preferred_username, name)
✅ Fail-closed on all errors
✅ No information disclosure in error messages
✅ JWKS cached with TTL
✅ Users auto-provisioned (prevents enumeration)
✅ Detailed logging server-side only
✅ No tokens logged in plaintext
