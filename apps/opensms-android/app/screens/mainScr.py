from kivymd.uix.boxlayout import MDBoxLayout
from kivymd.uix.button import MDButton, MDButtonIcon, MDButtonText

from kivy.lang import Builder
from kivy.uix.widget import Widget
from kivy.properties import StringProperty, NumericProperty, ObjectProperty
from kivy.metrics import dp, sp

Builder.load_string('''
<AppHomeBox>:
    orientation: 'vertical'
    #md_bg_color: '#7643a8'
    spacing: dp(8)
    padding: 8, 0, 8, 0

    MDLabel:
        id: 'api_srv_lbl'
        text: "Hello"
        adaptive_height: True

    MDButton:
        id: 'api_server_btn'
        style: "filled"
        pos_hint: {"center_x": .5}
        md_bg_color: '#7643a8'
        MDButtonIcon:
            icon: "play"
        MDButtonText:
            text: "Start Server"

    Widget:
        size_hint_y: 1

''')

class AppHomeBox(MDBoxLayout):
    pass
