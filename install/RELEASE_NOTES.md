## Download

| Your computer | Download |
|---|---|
| **Mac** with Apple silicon (M1 and later) | [Chattering-mac-arm64.dmg](https://github.com/MaximeRivest/chattering/releases/latest/download/Chattering-mac-arm64.dmg) |
| **Mac** with an Intel processor | [Chattering-mac-x64.dmg](https://github.com/MaximeRivest/chattering/releases/latest/download/Chattering-mac-x64.dmg) |
| **Windows** 10 or 11 | [Chattering-Setup-x64.exe](https://github.com/MaximeRivest/chattering/releases/latest/download/Chattering-Setup-x64.exe) · on ARM: [Chattering-Setup-arm64.exe](https://github.com/MaximeRivest/chattering/releases/latest/download/Chattering-Setup-arm64.exe) |
| **Linux** | `curl -fsSL https://raw.githubusercontent.com/MaximeRivest/chattering/master/install/install.sh \| sh` |

Everything it needs is inside: no Node, no Pi, no administrator password. It opens on a welcome that connects your AI (a Claude or ChatGPT plan, an API key, or a model on your own computer) and gets you to a first reply.

**Mac:** open the `.dmg`, drag Chattering onto Applications, and open it from there.
**Windows:** run the Setup; Chattering opens when it finishes, and is in the Start menu.

### The first time you open it

These first downloads are not yet signed by Apple or Microsoft, so each system asks once:

- **Mac:** a message says Apple could not check Chattering. Click **Done**, open **System Settings → Privacy & Security**, scroll down to “Chattering was blocked”, click **Open Anyway**, and confirm. After that it opens normally.
- **Windows:** “Windows protected your PC” appears. Click **More info**, then **Run anyway**.

The command-line install (below) does not ask, and installs the same thing:

- Mac and Linux: `curl -fsSL https://raw.githubusercontent.com/MaximeRivest/chattering/master/install/install.sh | sh`
- Windows (PowerShell): `irm https://raw.githubusercontent.com/MaximeRivest/chattering/master/install/install.ps1 | iex`

Every file's SHA-256 is in `SHA256SUMS`. Updates: `chattering-app update` (the previous version is kept: `chattering-app rollback`). Uninstalling removes the program; your conversations and settings stay.
