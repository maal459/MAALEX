import { Alert, Linking, TouchableOpacity, View, StyleSheet } from 'react-native';
import React from 'react';
import { FontAwesome } from '@expo/vector-icons';
import {
  APP_NAME,
  CONTACT_SETUP_MESSAGE,
  SUPPORT_PHONE_NUMBER,
  SUPPORT_WHATSAPP_MESSAGE,
} from './constants/appConfig';

const MessageUs = () => {
  const openWhatsApp = () => {
    if (!SUPPORT_PHONE_NUMBER) {
      Alert.alert(APP_NAME, CONTACT_SETUP_MESSAGE);
      return;
    }
    
    const phoneNumber = SUPPORT_PHONE_NUMBER;
    const message = SUPPORT_WHATSAPP_MESSAGE;
    
    const encodedMessage = encodeURIComponent(message);
    
    const whatsappUrl = `whatsapp://send?phone=${phoneNumber}&text=${encodedMessage}`;
    
    Linking.openURL(whatsappUrl).then((data) => {
      console.log('WhatsApp Opened');
    }).catch(() => {
      alert('Make sure WhatsApp is installed on your device');
    });
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={openWhatsApp}>
        <FontAwesome name="whatsapp" size={100} color="green" />
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#ffffff', // White background color
  },
});

export default MessageUs;
