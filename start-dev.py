import subprocess
import sys
import time
import webbrowser
import urllib.request
import os

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
URL = "http://localhost:5173"

def wait_for_server(url, timeout=30):
    start = time.time()
    while time.time() - start < timeout:
        try:
            urllib.request.urlopen(url, timeout=1)
            return True
        except Exception:
            time.sleep(0.5)
    return False

def main():
    print(f"Starting WEBASI dev server...")

    if sys.platform == "win32":
        proc = subprocess.Popen(
            ["cmd", "/k", "npm run dev"],
            cwd=PROJECT_DIR,
            creationflags=subprocess.CREATE_NEW_CONSOLE,
        )
    else:
        proc = subprocess.Popen(
            ["npm", "run", "dev"],
            cwd=PROJECT_DIR,
        )

    print(f"Waiting for server at {URL}...")
    if wait_for_server(URL):
        print(f"Server ready — opening {URL}")
        webbrowser.open(URL)
    else:
        print("Server didn't respond in 30s, opening browser anyway...")
        webbrowser.open(URL)

if __name__ == "__main__":
    main()
