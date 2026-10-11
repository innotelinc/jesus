import os
os.environ['KIVY_GL_BACKEND'] = 'sdl2'
import sys
import json
from threading import Thread

from kivy.lang import Builder
from kivy.core.window import Window
from kivy.utils import platform
from kivy.metrics import dp, sp
from kivy.clock import Clock
from kivy.properties import StringProperty, NumericProperty, ObjectProperty, BooleanProperty, ColorProperty

from kivymd.app import MDApp
from kivymd.uix.navigationbar import MDNavigationBar, MDNavigationItem
from kivymd.uix.screen import MDScreen
from kivymd.uix.boxlayout import MDBoxLayout
from kivymd.uix.button import MDButton, MDButtonIcon, MDButtonText
from kivymd.uix.label import MDLabel
from kivymd.uix.dialog import MDDialog
from kivymd.utils.set_bars_colors import set_bars_colors

# import screens (else pyinstaller may ignore it)
from screens.mainScr import ButtonControl
from screens.settings import SettingsBox

# IMPORTANT: Set this property for keyboard behavior
Window.softinput_mode = "below_target"

# import platform specific modules
if platform == "android":
    from jnius import autoclass, cast
    from android.permissions import check_permission, request_permissions, Permission
else:
    from services.appSvc import app_service_thread

# Local classes
class BaseMDNavigationItem(MDNavigationItem):
    icon = StringProperty()
    text = StringProperty()

class MainScreenBox(MDBoxLayout):
    top_pad = NumericProperty(0)
    bottom_pad = NumericProperty(0)
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if platform == "android":
            try:
                from android.display_cutout import get_height_of_bar
                self.top_pad = int(get_height_of_bar('status'))
                self.bottom_pad = int(get_height_of_bar('navigation'))
            except Exception as e:
                print(f"Failed android 15 padding: {e}")
                self.top_pad = 32
                self.bottom_pad = 48

## Global definitions
__version__ = "0.0.1" # App version

# Determine the base path for your application's resources
if getattr(sys, 'frozen', False):
    # Running as a PyInstaller bundle
    base_path = sys._MEIPASS
else:
    # Running in a normal Python environment
    base_path = os.path.dirname(os.path.abspath(__file__))
kv_file_path = os.path.join(base_path, 'main_layout.kv')

## Main App Class
class OpenSmsApp(MDApp):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.txt_dialog = None
        self.wake_lock = None
        self.api_started = False
        self.config_template = {
            "port": 9292,
            "boot": False,
        }
        self.req_template = {
            "port": 9292,
            "server": "stop",
        }

    def build(self):
        self.theme_cls.primary_palette = "Blue"
        self.theme_cls.accent_palette = "Orange"
        self.set_bars_colors()
        return Builder.load_file(kv_file_path)

    ## App logics
    def on_start(self):
        # paths setup
        file_m_height = 1
        # for android
        if platform == "android":
            file_m_height = 0.9
            from android.storage import app_storage_path
            sdk_version = 28
            try:
                VERSION = autoclass('android.os.Build$VERSION')
                sdk_version = VERSION.SDK_INT
                print(f"Android SDK: {sdk_version}")
                #self.show_toast_msg(f"Android SDK: {sdk_version}")
            except Exception as e:
                print(f"Could not check the android SDK version: {e}")
                #self.show_toast_msg(f"Error checking SDK: {e}", is_error=True)
            self.android_permissions = [Permission.WAKE_LOCK, Permission.SEND_SMS, Permission.POST_NOTIFICATIONS]
            request_permissions(self.android_permissions)
            self.internal_storage = app_storage_path()
            self.config_dir = os.path.join(self.internal_storage, 'config')
            os.makedirs(self.config_dir, exist_ok=True)
            self.request_path = os.path.join(self.config_dir, "request.json")
            self.resp_path = os.path.join(self.config_dir, "resp.json")
            self.write_request()
            # start the listner service on Android
            try:
                self.start_service()
            except Exception as e:
                print(f"Error while starting android service: {e}")
        # non android platforms
        else:
            self.internal_storage = self.user_data_dir
            self.config_dir = os.path.join(base_path, 'services', 'config')
            os.makedirs(self.config_dir, exist_ok=True)
            self.request_path = os.path.join(self.config_dir, "request.json")
            self.resp_path = os.path.join(self.config_dir, "resp.json")
            self.write_request()
            Thread(target=app_service_thread, daemon=True).start()
        # All generic things
        self.app_config = os.path.join(self.config_dir, "config.json")
        auto_start_sw = self.root.ids.settings_scr.ids.auto_start_sw
        port_no_inp = self.root.ids.settings_scr.ids.port_no_inp
        if os.path.exists(self.app_config):
            with open(self.app_config, "r") as cf:
                self.config_template = json.load(cf)
            print(f"start config check: {self.config_template}")
            self.req_template["port"] = int(self.config_template["port"])
            start_on_launch = self.config_template["boot"]
            if start_on_launch:
                self.req_template["server"] = "start"
                auto_start_sw.active = True
                Thread(target=self.write_request, daemon=True).start()
            else:
                auto_start_sw.active = False
        else:
            self.write_app_conf()
        port_no_inp.text = str(self.config_template["port"])
        Thread(target=self.resp_check_loop, daemon=True).start()
        print("Init success...")

    def start_service(self):
        PythonActivity = autoclass('org.kivy.android.PythonActivity')
        mActivity = PythonActivity.mActivity
        service = autoclass('in.daslearning.autocharge.ServiceOpensmssvc')
        #argument = ''
        argument = os.environ.get('PYTHON_SERVICE_ARGUMENT', '')
        print(f"PYTHON_SERVICE_ARGUMENT: {argument}")
        #service.start(mActivity, argument)
        service.start(mActivity, 'icon', 'OpenSMS API', 'Service Running' , argument)

    def stop_service(self):
        service = autoclass('in.daslearning.autocharge.ServiceOpensmssvc')
        PythonActivity = autoclass('org.kivy.android.PythonActivity')
        mActivity = PythonActivity.mActivity
        service.stop(mActivity)

    def resp_check_loop(self):
        import time
        api_srv_btn = self.root.ids.home_scr.ids.api_srv_btn
        api_srv_lbl = self.root.ids.home_scr.ids.api_srv_lbl
        while True:
            resp = None
            if os.path.exists(self.resp_path):
                try:
                    with open(self.resp_path, "r") as rf:
                        resp = json.load(rf)
                    if resp:
                        server_stat = resp.get("server", "")
                        if server_stat == "started":
                            if not self.api_started:
                                self.api_started = True
                                api_srv_lbl.text = f"API Server running on port: {self.req_template["port"]}"
                                api_srv_btn.btn_icon = "stop"
                                api_srv_btn.btn_txt = "Stop Server"
                                api_srv_btn.md_bg_color = "orange"
                                Clock.schedule_once(lambda dt: self.show_toast_msg("API Server Started"))
                        elif server_stat == "stopped":
                            if self.api_started:
                                self.api_started = False
                                api_srv_lbl.text = "API Server is not running"
                                api_srv_btn.btn_icon = "play"
                                api_srv_btn.btn_txt = "Start Server"
                                api_srv_btn.md_bg_color = "green"
                                Clock.schedule_once(lambda dt: self.show_toast_msg("API Server Stopped"))
                except Exception as e:
                    print(f"Error while reading resp: {e}")
            time.sleep(2)

    def write_app_conf(self):
        with open(self.app_config, "w") as cf:
            json.dump(self.config_template, cf)

    def write_request(self):
        with open(self.request_path, "w") as rf:
            json.dump(self.req_template, rf)

    def api_server_mgr(self, instance=None):
        if not self.api_started:
            self.req_template["server"] = "start"
            self.write_request()
        else:
            self.req_template["server"] = "stop"
            self.write_request()

    ## Settings sections
    def save_settings(self, instance=None, control_txt="none"):
        port_no_inp = self.root.ids.settings_scr.ids.port_no_inp
        flag = False
        if control_txt == "switch":
            if self.config_template["boot"]:
                self.config_template["boot"] = False
                flag = True
            else:
                self.config_template["boot"] = True
                flag = True
        if port_no_inp.text != "":
            port_no = int(port_no_inp.text)
            if port_no >= 1025:
                self.config_template["port"] = port_no
                self.req_template["port"] = port_no
        print(f"Service on start: {self.config_template["boot"]}, port: {self.config_template["port"]}")
        Thread(target=self.write_app_conf, daemon=True).start()

    def refresh_settings_view(self):
        auto_start_sw = self.root.ids.settings_scr.ids.auto_start_sw
        port_no_inp = self.root.ids.settings_scr.ids.port_no_inp
        if self.config_template["boot"]:
            auto_start_sw.active = True
        else:
            auto_start_sw.active = False
        port_no_inp.text = str(self.config_template["port"])

    def reset_settings(self, instance=None):
        self.config_template = {
            "port": 9292,
            "boot": False,
        }
        self.req_template["port"] = 9292
        print("Settings reset has been done!")
        self.refresh_settings_view()
        Thread(target=self.write_app_conf, daemon=True).start()

    ## App or UI related things
    def acquire_wakelock(self):
        if self.wake_lock:
            return  # already acquired
        try:
            PythonActivity = autoclass("org.kivy.android.PythonActivity")
            Context = autoclass("android.content.Context")
            activity = PythonActivity.mActivity
            PowerManager = autoclass("android.os.PowerManager")
            power_manager = cast(PowerManager, activity.getSystemService(Context.POWER_SERVICE))
            # Create wakelock (use PowerManager.FULL_WAKE_LOCK for full wakelock)
            self.wake_lock = power_manager.newWakeLock(
                PowerManager.FULL_WAKE_LOCK, "OpenSmsApp::WakeLockTag"
            )
            self.wake_lock.acquire()
            print("WakeLock acquired")
        except Exception as e:
            print(f"Wake lock aquire error: {e}")

    def release_wakelock(self):
        if self.wake_lock and self.wake_lock.isHeld():
            self.wake_lock.release()
            self.wake_lock = None
            print("WakeLock released")

    def show_toast_msg(self, message, is_error=False, duration=3):
        from kivymd.uix.snackbar import MDSnackbar, MDSnackbarText, MDSnackbarSupportingText
        bg_color = (0.2, 0.6, 0.2, 1) if not is_error else (0.8, 0.2, 0.2, 1)
        MDSnackbar(
            MDSnackbarText(
                text=message,
            ),
            y=dp(24),
            orientation="horizontal",
            pos_hint={"center_x": 0.5},
            background_color=bg_color,
        ).open()

    def show_text_dialog(self, title, text="", buttons=[]):
        self.txt_dialog = MDDialog(
            title=title,
            text=text,
            buttons=buttons
        )
        self.txt_dialog.open()

    def txt_dialog_closer(self, instance):
        if self.txt_dialog:
            self.txt_dialog.dismiss()

    # UI bar colour
    def set_bars_colors(self):
        set_bars_colors(
            self.theme_cls.primary_palette,  # status bar color
            self.theme_cls.primary_palette,  # navigation bar color
            "Light",                         # icons color of status bar
        )

    # run on app exit
    def on_stop(self):
        print("Exiting the app...")
        if platform == "android":
            self.stop_service()
            self.release_wakelock()

    # on bottom navigation
    def on_switch_tabs(
            self,
            bar: MDNavigationBar,
            item: MDNavigationItem,
            item_icon: str,
            item_text: str,
        ):
            self.root.ids.screen_manager.current = item_text


if __name__ == '__main__':
    OpenSmsApp().run()
