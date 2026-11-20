#!/bin/sh
stty cols 180 rows 60
exec "${AGY_BIN:-agy}"
