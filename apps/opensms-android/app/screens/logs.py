from kivymd.uix.boxlayout import MDBoxLayout
from kivymd.uix.button import MDButton, MDButtonIcon, MDButtonText

from kivy.lang import Builder
from kivy.uix.widget import Widget
from kivy.properties import StringProperty, NumericProperty, ObjectProperty, ColorProperty
from kivy.metrics import dp, sp
from kivy.utils import platform

# local imports
from services.logSvc import LogService

Builder.load_string('''

<LogBox>:
    orientation: "vertical"

    MDScrollView:
        do_scroll_x: False

        MDBoxLayout:
            id: log_box
            orientation: "vertical"
            adaptive_height: True

            MDLabel:
                id: log_container
                adaptive_height: True
                valign: "top"
                text: "No logs yet!"
                font_style: "Label"
                role: "small"

''')

class LogBox(MDBoxLayout):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.app_name = "opensms"
        self.logger = LogService(self.app_name, platform)

    def log_show(self, instance=None):
        text_log = ""
        container = self.ids.log_container
        logs = self.logger.get_api_logs()
        for line in reversed(logs):
            clean_line = line.strip()
            if clean_line:
                text_log = text_log + f"{clean_line}\n"
        container.text = text_log
