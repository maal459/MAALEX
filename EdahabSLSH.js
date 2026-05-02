import React, { useState } from 'react';
import { View, SafeAreaView, Image, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ScrollView } from 'react-native';
import { Linking } from 'react-native';
import COLORS from './colors';

const EdahabSLSHScreen = ({ route }) => {
  const { params: { plant } } = route;
  const [lastNumber, setLastNumber] = useState('');

  const handlePress = async () => {
    if (!lastNumber.trim() || isNaN(lastNumber)) {
      Alert.alert('Invalid Input', 'Please enter a valid number.');
      return;
    }
    
    const code = `*119*659888668*${lastNumber}#`;
    const uriEncodedCode = encodeURIComponent(code);
    const url = `tel:${uriEncodedCode}`;
  
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        Linking.openURL(url);
      } else {
        Alert.alert('Unsupported Feature', "Your device can't dial USSD codes. Please try on another device or contact support for assistance.");
      }
    } catch (error) {
      Alert.alert('Error', 'An unexpected error occurred: ' + error.message);
    }
  };
  

  return (
    <ScrollView>
      <SafeAreaView style={styles.container}>
        <Image source={plant.img} style={styles.image} />
        <View style={styles.detailsContainer}>
          <Text style={styles.title}>Somaliland Shilling ayaad heli doontaa</Text>
          <Text style={styles.description}>{plant.about}</Text>
          <TextInput
            style={styles.input}
            onChangeText={setLastNumber}
            value={lastNumber}
            placeholder="Geli lacagta aad sarifanayso"
            keyboardType="numeric"
          />
          <TouchableOpacity onPress={handlePress} style={styles.buyBtn}>
            <Text style={styles.buyBtnText}>Sarifo</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.white,
  },
  image: {
    resizeMode: 'contain',
    flex: 2,
    marginTop: 80,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf:'center'
  },
  detailsContainer: {
    flex: 1,
    backgroundColor: COLORS.light,
    margin: 7,
    borderRadius: 20,
    padding: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  description: {
    color: 'grey',
    fontSize: 16,
    lineHeight: 22,
    marginTop: 10,
  },
  input: {
    height: 40,
    marginVertical: 12,
    borderBottomWidth: 1,
    padding: 10,
    color: '#000',
    borderRadius: 50,
    textAlign: 'center',
    fontSize: 18
  },
  buyBtn: {
    backgroundColor: '#347dce',
    height: 50,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buyBtnText: {
    color: COLORS.white,
    fontSize: 18,
    fontWeight: 'bold',
  },
});

export default EdahabSLSHScreen;
