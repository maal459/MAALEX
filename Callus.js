import React from 'react';
import { Alert, View, TouchableOpacity, Text, StyleSheet,Linking } from 'react-native';
import { Feather } from '@expo/vector-icons';
import {
  APP_NAME,
  CONTACT_SETUP_MESSAGE,
  SUPPORT_PHONE_NUMBER,
} from './constants/appConfig';

const CallUs = () => {
  const phoneNumber = SUPPORT_PHONE_NUMBER;

  const handleCallPress = () => {
    if (!phoneNumber) {
      Alert.alert(APP_NAME, CONTACT_SETUP_MESSAGE);
      return;
    }

    Linking.openURL(`tel:${phoneNumber}`).then((data) => {
      console.log('Phone call initiated');
    }).catch(() => {
      console.log('Failed to initiate phone call');
    });
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.button} onPress={handleCallPress}>
        <Feather name="phone-call" size={24} color="white" />
        <Text style={styles.text}>Call Us</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#007815',
    padding: 30,
    borderRadius: 15,
  },
  text: {
    marginLeft: 10,
    color: 'white',
    fontSize: 18,
  },
});

export default CallUs;
