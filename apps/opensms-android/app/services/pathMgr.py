import os
import sys
from pathlib import Path

def get_user_data_dir(app_name: str) -> Path:
    """
    Returns a safe, user-specific data directory for Linux and Windows.
    Creates the directory if it does not already exist.
    """
    home = Path.home()

    if sys.platform.startswith("win"):
        # Windows standard: %LOCALAPPDATA% (or fallback to ~/AppData/Local)
        base_dir = os.environ.get("LOCALAPPDATA")
        if base_dir:
            data_dir = Path(base_dir) / app_name
        else:
            data_dir = home / "AppData" / "Local" / app_name

    else:
        # Linux / Unix standard: XDG_DATA_HOME (or fallback to ~/.local/share)
        xdg_data = os.environ.get("XDG_DATA_HOME")
        if xdg_data:
            data_dir = Path(xdg_data) / app_name
        else:
            data_dir = home / ".local" / "share" / app_name

    # Safely create the folder
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir
