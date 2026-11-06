#!/usr/bin/env python3
"""
GPT Image Free 凭据授权 worker。

把「邮箱 / 密码 / 2FA 密钥」批量换成 OpenAI 的 access_token / refresh_token /
id_token，供 Rust 侧统一写入本机 chatgpt2api 号池。本身不写入号池、不落盘任何凭据。

约定：
  stdin  <- {"accounts":[{"email","password","totp_secret","access_token","refresh_token"}],
             "source_dir":"<data_dir>/source", "proxy":""}
  stdout -> {"ok":true,"results":[{"email","ok","access_token","refresh_token","id_token","error"}]}
所有诊断信息只走 stderr，stdout 恒为一条 JSON，便于宿主解析。
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
import socket
import struct
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

AUTH_BASE = "https://auth.openai.com"
PLATFORM_BASE = "https://platform.openai.com"
OAUTH_CLIENT_ID = "app_2SKx67EdpoN0G6j64rFvigXD"
OAUTH_AUDIENCE = "https://api.openai.com/v1"
OAUTH_REDIRECT = "https://platform.openai.com/auth/callback"
AUTH0_CLIENT = "eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjEuMjEuMCJ9"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
)

_requests = None
_generate_pkce = None
_build_sentinel_token = None


def log(message: str) -> None:
    print(f"[auth-worker] {message}", file=sys.stderr, flush=True)


def load_source(source_dir: str) -> bool:
    """把本机后端 source 放进 sys.path，复用它的 PKCE / sentinel 实现。"""
    candidates = [
        source_dir,
        str(Path.cwd()),
        str(Path.home() / ".dsh" / "chatgpt2api-native" / "source"),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        root = Path(candidate)
        if (root / "utils" / "pkce.py").is_file() and (root / "utils" / "sentinel.py").is_file():
            if str(root) not in sys.path:
                sys.path.insert(0, str(root))
            return True
    return False


def parse_jwt_exp(token: str) -> float:
    """不验签，只判断自带 token 是否还没过期（>60s 余量才复用）。"""
    try:
        parts = str(token).split(".")
        if len(parts) != 3:
            return 0.0
        padded = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
        return float(json.loads(base64.urlsafe_b64decode(padded).decode("utf-8")).get("exp") or 0)
    except Exception:
        return 0.0


def get_totp(secret: str) -> str:
    """从 Base32 密钥算当前 6 位 TOTP。"""
    clean = secret.replace(" ", "").upper()
    clean += "=" * ((8 - len(clean) % 8) % 8)
    key = base64.b32decode(clean)
    counter = int(time.time() // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[19] & 0x0F
    code = (struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{code:06d}"


def resolve_proxy(custom: str, source_dir: str) -> str:
    """优先用显式传入，其次后端 config.json，再环境变量，最后探测常见本地端口。"""
    if custom and custom.strip():
        return custom.strip()
    if source_dir:
        try:
            cfg = json.loads((Path(source_dir) / "config.json").read_text(encoding="utf-8"))
            value = str(cfg.get("proxy") or "").strip()
            if value:
                return value
        except Exception:
            pass
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    for port in (7890, 7897, 10809, 10808):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.15):
                return f"http://127.0.0.1:{port}"
        except OSError:
            continue
    return ""


def _auth_headers(device_id: str, referer: str) -> dict:
    return {
        "accept": "application/json",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/json",
        "origin": AUTH_BASE,
        "priority": "u=1, i",
        "user-agent": USER_AGENT,
        "sec-ch-ua": '"Chromium";v="145", "Google Chrome";v="145", "Not/A)Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "referer": referer,
        "oai-device-id": device_id,
    }


def _code_from(data: dict) -> str:
    url = str((data or {}).get("continue_url") or "").strip()
    if "code=" not in url:
        return ""
    return str((parse_qs(urlparse(url).query).get("code") or [""])[0]).strip()


def login_with_password_and_totp(email: str, password: str, totp_secret: str, proxy: str) -> dict:
    """OAuth + PKCE + 密码 + TOTP，换出 token 三件套。"""
    if _requests is None or _generate_pkce is None:
        return {"ok": False, "error": "dependencies_missing", "detail": "curl_cffi / utils 未加载"}

    kwargs = {"impersonate": "chrome110", "verify": False}
    if proxy:
        kwargs["proxy"] = proxy
    session = _requests.Session(**kwargs)
    device_id = str(uuid.uuid4())
    code_verifier, code_challenge = _generate_pkce()
    session.cookies.set("oai-did", device_id, domain=".auth.openai.com")
    session.cookies.set("oai-did", device_id, domain="auth.openai.com")

    params = {
        "issuer": AUTH_BASE,
        "client_id": OAUTH_CLIENT_ID,
        "audience": OAUTH_AUDIENCE,
        "redirect_uri": OAUTH_REDIRECT,
        "device_id": device_id,
        "screen_hint": "login_or_signup",
        "max_age": "0",
        "login_hint": email,
        "scope": "openid profile email offline_access",
        "response_type": "code",
        "response_mode": "query",
        "state": secrets.token_urlsafe(32),
        "nonce": secrets.token_urlsafe(32),
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "auth0Client": AUTH0_CLIENT,
    }
    authorize_url = f"{AUTH_BASE}/api/accounts/authorize?{urlencode(params)}"
    try:
        resp = session.get(
            authorize_url,
            headers={"user-agent": USER_AGENT, "accept-language": "zh-CN,zh;q=0.9"},
            allow_redirects=True,
            timeout=30,
        )
    except Exception as exc:
        return {"ok": False, "error": "authorize_network_error", "detail": str(exc)[:200]}
    if resp.status_code not in (200, 302):
        return {"ok": False, "error": f"authorize_failed_{resp.status_code}"}

    headers = _auth_headers(device_id, f"{AUTH_BASE}/email-verification")
    if _build_sentinel_token:
        try:
            sentinel, oai_sc = _build_sentinel_token(session, device_id, "password_verify")
            headers["openai-sentinel-token"] = sentinel
            if oai_sc:
                session.cookies.set("oai-sc", oai_sc, domain=".openai.com")
        except Exception:
            pass
    try:
        login_resp = session.post(
            f"{AUTH_BASE}/api/accounts/password/verify",
            headers=headers,
            json={"password": password},
            timeout=30,
        )
    except Exception as exc:
        return {"ok": False, "error": "password_verify_network_error", "detail": str(exc)[:200]}
    try:
        login_data = login_resp.json() if login_resp.text else {}
    except Exception:
        login_data = {}
    if login_resp.status_code != 200:
        err = (login_data.get("error") or {}) if isinstance(login_data, dict) else {}
        message = str(err.get("message") or "")
        if "Invalid credentials" in message or "wrong password" in message.lower():
            return {"ok": False, "error": "invalid_password"}
        return {"ok": False, "error": f"password_verify_failed_{login_resp.status_code}"}

    auth_code = _code_from(login_data)
    if not auth_code:
        page = (login_data.get("page") or {}) if isinstance(login_data, dict) else {}
        page_type = str(page.get("type") or "")
        if page_type == "email_otp_verification":
            return {"ok": False, "error": "need_email_verification_code", "detail": "上游要求邮箱验证码，无法自动登录"}
        if page_type != "mfa_challenge":
            return {"ok": False, "error": "no_auth_code"}
        payload = page.get("payload") or {}
        factor_id = str(payload.get("factor_id") or "")
        if not factor_id:
            factors = payload.get("factors") or []
            factor_id = str((factors[0] if factors else {}).get("id") or "")
        if not factor_id:
            return {"ok": False, "error": "mfa_challenge_no_factor_id"}
        if not totp_secret:
            return {"ok": False, "error": "mfa_challenge_requires_totp_secret"}
        try:
            code = get_totp(totp_secret)
        except binascii.Error:
            return {"ok": False, "error": "invalid_totp_secret_base32"}
        except Exception as exc:
            return {"ok": False, "error": "totp_generation_failed", "detail": str(exc)[:200]}

        mfa_headers = dict(headers)
        mfa_headers["referer"] = f"{AUTH_BASE}/mfa-challenge/{factor_id}"
        if _build_sentinel_token:
            try:
                sentinel, oai_sc = _build_sentinel_token(session, device_id, "verify_mfa")
                mfa_headers["openai-sentinel-token"] = sentinel
                if oai_sc:
                    session.cookies.set("oai-sc", oai_sc, domain=".openai.com")
            except Exception:
                pass
        try:
            mfa_resp = session.post(
                f"{AUTH_BASE}/api/accounts/mfa/verify",
                headers=mfa_headers,
                json={"id": factor_id, "type": "totp", "code": code},
                timeout=30,
            )
        except Exception as exc:
            return {"ok": False, "error": "mfa_verify_network_error", "detail": str(exc)[:200]}
        if mfa_resp.status_code != 200:
            return {"ok": False, "error": f"mfa_verify_failed_{mfa_resp.status_code}"}
        try:
            mfa_data = mfa_resp.json() if mfa_resp.text else {}
        except Exception:
            mfa_data = {}
        auth_code = _code_from(mfa_data)
    if not auth_code:
        return {"ok": False, "error": "no_auth_code_obtained"}

    token_headers = {
        "accept": "*/*",
        "accept-language": "zh-CN,zh;q=0.9",
        "auth0-client": AUTH0_CLIENT,
        "content-type": "application/json",
        "origin": PLATFORM_BASE,
        "referer": f"{PLATFORM_BASE}/",
        "user-agent": USER_AGENT,
    }
    try:
        token_resp = session.post(
            f"{AUTH_BASE}/api/accounts/oauth/token",
            headers=token_headers,
            json={
                "client_id": OAUTH_CLIENT_ID,
                "code_verifier": code_verifier,
                "grant_type": "authorization_code",
                "code": auth_code,
                "redirect_uri": OAUTH_REDIRECT,
            },
            timeout=60,
        )
    except Exception as exc:
        return {"ok": False, "error": "token_exchange_network_error", "detail": str(exc)[:200]}
    if token_resp.status_code != 200:
        return {"ok": False, "error": f"token_exchange_failed_{token_resp.status_code}"}
    try:
        token_data = token_resp.json() if token_resp.text else {}
    except Exception:
        token_data = {}
    access_token = str(token_data.get("access_token") or "").strip()
    if not access_token:
        return {"ok": False, "error": "empty_access_token"}
    return {
        "ok": True,
        "access_token": access_token,
        "refresh_token": str(token_data.get("refresh_token") or "").strip(),
        "id_token": str(token_data.get("id_token") or "").strip(),
    }


def emit(data: dict) -> None:
    print(json.dumps(data, ensure_ascii=False), flush=True)


def main() -> None:
    global _requests, _generate_pkce, _build_sentinel_token
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        emit({"ok": False, "error": f"输入 JSON 无效：{exc}", "results": []})
        return
    accounts = payload.get("accounts") if isinstance(payload, dict) else None
    if not isinstance(accounts, list):
        accounts = []
    if not accounts:
        emit({"ok": True, "results": []})
        return

    source_dir = str(payload.get("source_dir") or "")
    proxy = resolve_proxy(str(payload.get("proxy") or ""), source_dir)
    if not load_source(source_dir):
        emit({"ok": False, "error": "未找到本机后端 source/utils/pkce.py 与 sentinel.py", "results": []})
        return
    try:
        from curl_cffi import requests as _rq
        from utils.pkce import generate_pkce as _pkce
        _requests = _rq
        _generate_pkce = _pkce
        try:
            from utils.sentinel import build_sentinel_token as _sentinel
            _build_sentinel_token = _sentinel
        except Exception:
            _build_sentinel_token = None
    except Exception as exc:
        emit({"ok": False, "error": f"依赖缺失：{exc}", "results": []})
        return

    results = []
    for item in accounts:
        if not isinstance(item, dict):
            continue
        email = str(item.get("email") or "").strip()
        password = str(item.get("password") or "")
        totp = str(item.get("totp_secret") or item.get("auxiliary") or "").strip()
        cached = str(item.get("access_token") or "").strip()
        cached_refresh = str(item.get("refresh_token") or "").strip()
        if not email or not password:
            results.append({"email": email, "ok": False, "error": "邮箱或密码为空"})
            continue
        # 自带且未过期的 token 直接复用，不再打扰上游登录。
        if cached and parse_jwt_exp(cached) > time.time() + 60:
            results.append({
                "email": email, "ok": True, "access_token": cached,
                "refresh_token": cached_refresh, "id_token": "", "cached": True,
            })
            continue
        log(f"开始授权 {email}")
        try:
            res = login_with_password_and_totp(email, password, totp, proxy)
        except Exception as exc:
            res = {"ok": False, "error": "login_exception", "detail": str(exc)[:200]}
        if res.get("ok"):
            results.append({
                "email": email,
                "ok": True,
                "access_token": str(res.get("access_token") or ""),
                "refresh_token": str(res.get("refresh_token") or cached_refresh or ""),
                "id_token": str(res.get("id_token") or ""),
            })
            log(f"{email} 授权成功")
        else:
            reason = str(res.get("error") or "login_failed")
            results.append({"email": email, "ok": False, "error": reason})
            log(f"{email} 授权失败：{reason}")
    emit({"ok": True, "results": results})


if __name__ == "__main__":
    main()
