from kivy.utils import platform

## OS specific setups
# for android
if platform == "android":
    from jnius import autoclass

## functions

def send_sms(phone:str, msg:str):
    stat = False
    if platform == "android":
        try:
            SmsManager = autoclass('android.telephony.SmsManager')
            sms_manager = SmsManager.getDefault()
            sms_manager.sendTextMessage(phone, None, msg, None, None)
            stat = True
        except Exception as e:
            print("SMS ❌ Failed:", e)
    else:
        stat = True
    return stat
