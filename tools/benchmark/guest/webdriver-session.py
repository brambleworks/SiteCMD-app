import json
import os
from pathlib import Path
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class WebDriverSession:
    def __init__(self):
        self.processes = []
        self.logs = []
        self.session = None

    def request(self, route, body=None, method="POST"):
        message = Request(
            "http://127.0.0.1:4444" + route, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urlopen(message, timeout=20) as response:
                value = json.load(response)["value"]
        except HTTPError as error:
            raise RuntimeError(error.read().decode()) from error
        if isinstance(value, dict) and value.get("error"):
            raise RuntimeError(json.dumps(value))
        return value

    def start(self):
        environment = dict(os.environ)
        environment.update({
            "DISPLAY": ":99", "HOME": "/tmp/browser-home", "XDG_RUNTIME_DIR": "/tmp/browser-run",
            "LIBGL_ALWAYS_SOFTWARE": "1", "WEBKIT_DISABLE_DMABUF_RENDERER": "1",
            "NO_AT_BRIDGE": "1",
        })
        for directory in [environment["HOME"], environment["XDG_RUNTIME_DIR"]]:
            Path(directory).mkdir(mode=0o700)
        commands = [
            ["/usr/bin/Xvfb", ":99", "-screen", "0", "1024x768x24", "-nolisten", "tcp"],
            ["/usr/bin/dbus-run-session", "--", "/usr/bin/WebKitWebDriver", "--port=4444", "--host=127.0.0.1"],
        ]
        for i, command in enumerate(commands):
            log = open(f"/tmp/browser-process-{i}.log", "w+")
            self.logs.append(log)
            self.processes.append(subprocess.Popen(command, env=environment, stdout=log, stderr=log))
            if i == 0:
                deadline = time.monotonic() + 5
                while not Path("/tmp/.X11-unix/X99").exists():
                    if time.monotonic() >= deadline or self.processes[0].poll() is not None:
                        raise RuntimeError("Xvfb did not start")
                    time.sleep(0.05)
        deadline = time.monotonic() + 5
        while True:
            try:
                self.request("/status", method="GET")
                break
            except URLError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)
        created = self.request("/session", {"capabilities": {"alwaysMatch": {
            "browserName": "MiniBrowser", "browserVersion": "2.52.6",
            "webkitgtk:browserOptions": {
                "binary": "/usr/lib/aarch64-linux-gnu/webkit2gtk-4.1/MiniBrowser",
                "args": ["--automation", "--enable-sandbox"],
            },
        }}})
        self.session = created["sessionId"]
        self.capabilities = created["capabilities"]
        self.command("/timeouts", {"script": 10000, "pageLoad": 15000, "implicit": 0})

    def command(self, route, body=None, method="POST"):
        return self.request(f"/session/{self.session}" + route, body, method)

    def evaluate(self, script, *args):
        return self.command("/execute/sync", {"script": script, "args": args})

    def sandbox_evidence(self):
        processes = []
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                command = (entry / "cmdline").read_bytes().split(b"\0")[0].decode()
                if Path(command).name != "WebKitWebProcess":
                    continue
                status = dict(line.split(":", 1) for line in (entry / "status").read_text().splitlines())
                processes.append({
                    "pid": int(entry.name), "seccomp": status["Seccomp"].strip(),
                    "noNewPrivileges": status["NoNewPrivs"].strip(),
                    "separateMountNamespace": os.readlink(entry / "ns/mnt") != os.readlink("/proc/self/ns/mnt"),
                })
            except (FileNotFoundError, ProcessLookupError):
                continue
        return processes

    def close(self):
        if self.session:
            try:
                self.command("", method="DELETE")
            except Exception:
                pass
        for process in reversed(self.processes):
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        captured = []
        for log in self.logs:
            log.seek(0)
            captured.append(log.read(65536))
            log.close()
        return captured
