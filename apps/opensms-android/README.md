# OpenSMS
An open-source app which can turn your `Android` phone into a `SMS API Server`.


#### Test API endpoint
```bash
curl -X POST http://192.168.x.x:9292/sms/ \
  -H "Content-Type: application/json" \
  -d '{"number":"+91xxxxxxxxxx","text":"Test API message"}'
```

#### Linux Dependencies for build
```bash
sudo apt install libcairo2-dev pkg-config python3-dev
sudo apt-get install libjpeg-dev zlib1g-dev
```
